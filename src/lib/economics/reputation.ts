// ReputationService — transparent, explainable provider reputation.
//
// ARCHITECTURE: all pure reputation calculations live in
// src/lib/economics/shared.ts (calculateReputation, deriveTier, decayWeight,
// valueWeight). This module is the DB orchestration layer: it fetches
// execution legs + disputes from the database, applies recency + value
// weighting (using the shared decay/weight functions), builds a
// ReputationInput, and calls shared.calculateReputation.
//
// Reputation NEVER overrides hard risk constraints. It only affects route
// RANKING among already-eligible routes.

import { db } from "@/lib/db";
import {
  calculateReputation,
  deriveTier,
  decayWeight,
  valueWeight,
  MEANINGFUL_THRESHOLD,
  type ReputationComponents,
  type ReputationInput,
} from "@/lib/economics/shared";

export type { ReputationComponents } from "@/lib/economics/shared";

export interface ReputationResult {
  providerId: string;
  components: ReputationComponents;
  tier: string;
  tierReason: string;
}

// Compute the full reputation profile for a provider from historical data.
// Uses time-weighted decay: executions within 7 days get full weight,
// 7-30 days get 0.5 weight, 30-90 days get 0.25 weight, older get 0.1 weight.
export async function getProviderReputation(providerId: string): Promise<ReputationResult> {
  const now = Date.now();
  const cutoff90d = new Date(now - 90 * 86400000);

  // Fetch the provider's execution legs in the last 90 days.
  const legs = await db.leg.findMany({
    where: {
      providerId,
      execution: { startedAt: { gte: cutoff90d } },
    },
    include: {
      execution: { include: { intent: true } },
      offer: true,
    },
    orderBy: { execution: { startedAt: "asc" } },
  });

  // Dispute + slash counts — weighted by recency (same decay as executions).
  const disputeRecords = await db.dispute.findMany({
    where: { providerId, createdAt: { gte: cutoff90d } },
    select: { createdAt: true, status: true },
  });
  let weightedDisputes = 0;
  let weightedSlashes = 0;
  for (const d of disputeRecords) {
    const ageMs = now - d.createdAt.getTime();
    const recency = decayWeight(ageMs);
    weightedDisputes += recency;
    if (d.status === "SLASHED") weightedSlashes += recency;
  }

  // Compute weighted metrics — ANTI-GAMING: only transactions >= $50
  // (MEANINGFUL_THRESHOLD) contribute. Each meaningful transaction is weighted
  // by sqrt(volume / base) × recency_decay (using shared valueWeight + decayWeight).
  let totalWeight = 0;
  let weightedCompleted = 0;
  let weightedFailed = 0;
  let weightedCancelled = 0;
  let weightedDurationSum = 0;
  let weightedDurationCount = 0;
  let meaningfulExecutions = 0;

  for (const leg of legs) {
    const exec = leg.execution;
    if (!exec) continue;
    const volume = Number(leg.amount.toString());

    // Anti-gaming: skip sub-threshold transactions entirely.
    if (volume < MEANINGFUL_THRESHOLD) continue;

    meaningfulExecutions++;
    const ageMs = now - exec.startedAt.getTime();
    const recency = decayWeight(ageMs);
    const vw = valueWeight(volume); // sqrt(volume / base), capped at 3.0
    const weight = vw * recency;
    totalWeight += weight;

    if (exec.status === "COMPLETED") weightedCompleted += weight;
    else if (exec.status === "FAILED" || leg.status === "FAILED") weightedFailed += weight;
    else if (exec.status === "CANCELLED") weightedCancelled += weight;

    if (exec.status === "COMPLETED" && exec.completedAt) {
      const durationSec = (exec.completedAt.getTime() - exec.startedAt.getTime()) / 1000;
      weightedDurationSum += durationSec * weight;
      weightedDurationCount += weight;
    }
  }

  const avgDuration = weightedDurationCount > 0 ? weightedDurationSum / weightedDurationCount : 0;

  // Liquidity quality: derive from utilization (lower = better).
  const offers = await db.liquidityOffer.findMany({
    where: { providerId },
    select: { availableCapacity: true, reservedCapacity: true, active: true, feeBps: true },
  });
  const activeOffers = offers.filter((o) => o.active);
  const utilization = activeOffers.length > 0
    ? activeOffers.reduce((s, o) => {
        const avail = Number(o.availableCapacity.toString());
        const res = Number(o.reservedCapacity.toString());
        return s + (avail > 0 ? (res / avail) : 0);
      }, 0) / activeOffers.length
    : 0;

  // Pricing: competitiveness vs network median fee.
  const medianFee = await getMedianNetworkFee();
  const providerMedianFee = activeOffers.length > 0
    ? activeOffers.reduce((s, o) => s + o.feeBps, 0) / activeOffers.length
    : medianFee;

  // History: how long the provider has been active.
  const provider = await db.liquidityProvider.findUnique({
    where: { id: providerId },
    select: { createdAt: true, status: true, tier: true },
  });
  const ageDays = provider ? (now - provider.createdAt.getTime()) / 86400000 : 0;

  // Build the shared ReputationInput and delegate the pure calculation.
  const repInput: ReputationInput = {
    completed: 0, // raw counts not needed — weighted values are authoritative
    failed: 0,
    cancelled: 0,
    disputes: 0,
    slashes: 0,
    avgDurationSeconds: avgDuration,
    utilization,
    medianFeeBps: providerMedianFee,
    networkMedianFeeBps: medianFee,
    ageDays,
    weightedCompleted,
    weightedFailed,
    weightedCancelled,
    weightedDisputes,
    weightedSlashes,
    meaningfulExecutions,
  };

  const components = calculateReputation(repInput);
  const tier = deriveTier(components.overall, meaningfulExecutions, ageDays, weightedSlashes);
  const tierReason = getTierReason(tier, components.overall, meaningfulExecutions, ageDays);

  return {
    providerId,
    components,
    tier,
    tierReason,
  };
}

async function getMedianNetworkFee(): Promise<number> {
  const offers = await db.liquidityOffer.findMany({
    where: { active: true },
    select: { feeBps: true },
  });
  if (offers.length === 0) return 20;
  const fees = offers.map((o) => o.feeBps).sort((a, b) => a - b);
  const mid = Math.floor(fees.length / 2);
  return fees.length % 2 !== 0 ? fees[mid] : (fees[mid - 1] + fees[mid]) / 2;
}

function getTierReason(tier: string, rep: number, execs: number, ageDays: number): string {
  switch (tier) {
    case "PREMIUM": return `Reputation ${rep}, ${execs} meaningful executions, ${Math.round(ageDays)}d active`;
    case "TRUSTED": return `Reputation ${rep}, ${execs} executions, ${Math.round(ageDays)}d active`;
    case "VERIFIED": return `${execs} executions, ${Math.round(ageDays)}d active`;
    default: return "New provider — building history";
  }
}

// Batch compute reputation for all active providers. Returns a map:
// providerId → reputation (0..1, used by the routing engine).
export async function getReputationMap(): Promise<Map<string, number>> {
  const providers = await db.liquidityProvider.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });
  const map = new Map<string, number>();
  for (const p of providers) {
    const rep = await getProviderReputation(p.id);
    map.set(p.id, rep.components.overall / 100);
  }
  return map;
}

// Get corridor-specific performance for a provider. Returns 0..1 score.
export async function getCorridorScore(
  providerId: string,
  sourceAsset: string,
  destinationAsset: string,
  sourceCountry: string,
  destinationCountry: string,
): Promise<number> {
  const score = await db.providerCorridorScore.findUnique({
    where: {
      providerId_sourceAsset_destinationAsset_sourceCountry_destinationCountry: {
        providerId, sourceAsset, destinationAsset, sourceCountry, destinationCountry,
      },
    },
  });
  return score ? score.score : 0.5;
}

// Batch compute corridor scores for ALL provider+corridor combinations.
// Returns a map keyed by "providerId:srcAsset:dstAsset:srcCountry:dstCountry".
export async function getCorridorScoreMap(): Promise<Map<string, number>> {
  const scores = await db.providerCorridorScore.findMany({
    select: { providerId: true, sourceAsset: true, destinationAsset: true, sourceCountry: true, destinationCountry: true, score: true },
  });
  const map = new Map<string, number>();
  for (const s of scores) {
    const key = `${s.providerId}:${s.sourceAsset}:${s.destinationAsset}:${s.sourceCountry}:${s.destinationCountry}`;
    map.set(key, s.score);
  }
  return map;
}
