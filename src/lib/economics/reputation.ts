// ReputationService — transparent, explainable provider reputation.
//
// ARCHITECTURE RULE: reputation is DERIVED from observable historical behavior
// (execution outcomes, dispute records, liquidity reliability). It is never an
// opaque AI score. The service computes explainable components that can be
// expanded in the UI ("Why is this provider rated 91?").
//
// Reputation NEVER overrides hard risk constraints. It only affects route
// RANKING among already-eligible routes.
//
// Time-weighted decay: recent behavior matters more than old behavior.
// Anti-gaming: tiny transactions, self-generated volume, and repetitive
// zero-risk activity contribute less.

import { db } from "@/lib/db";
import { Decimal } from "@/lib/engine/money";

const DAY_MS = 86400000;

export interface ReputationComponents {
  reliability: number;    // 0..100 — did the provider fulfill accepted executions?
  speed: number;          // 0..100 — how quickly did it execute?
  liquidityQuality: number; // 0..100 — did advertised liquidity stay available?
  pricing: number;        // 0..100 — how competitive were its offers?
  disputes: number;       // 0..100 — how few disputes?
  operational: number;    // 0..100 — how few manual/API failures?
  history: number;        // 0..100 — how long active?
  overall: number;        // 0..100 — weighted composite
  sampleSize: number;     // number of meaningful executions analyzed
  decayNote: string;      // human-readable decay explanation
}

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
  const cutoff90d = new Date(now - 90 * DAY_MS);

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

  // Dispute + slash counts.
  const disputes = await db.dispute.count({ where: { providerId, createdAt: { gte: cutoff90d } } });
  const slashes = await db.dispute.count({ where: { providerId, status: "SLASHED", createdAt: { gte: cutoff90d } } });

  // Compute weighted metrics — ANTI-GAMING: only transactions >= $50
  // (MEANINGFUL_THRESHOLD) contribute to reputation components. Each
  // meaningful transaction is weighted by sqrt(volume / base) × recency_decay,
  // so a thousand $1 transactions have zero effect, and a single huge
  // transaction doesn't dominate either (sqrt dampens large values).
  const MEANINGFUL_THRESHOLD = 50;
  const VALUE_BASE = 100; // $100 = weight 1.0 (before recency)
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
    // They do NOT contribute to reliability, speed, disputes, or operational
    // scores — only meaningful transactions (≥ $50) count.
    if (volume < MEANINGFUL_THRESHOLD) continue;

    meaningfulExecutions++;
    const ageMs = now - exec.startedAt.getTime();
    const recency = decayWeight(ageMs);
    // Value weighting: sqrt(volume / base) × recency. This ensures:
    //   - $50 tx → sqrt(0.5) ≈ 0.71 × recency
    //   - $100 tx → 1.0 × recency
    //   - $10,000 tx → sqrt(100) = 10 × recency (capped at 3.0 to prevent dominance)
    const valueWeight = Math.min(3.0, Math.sqrt(volume / VALUE_BASE));
    const weight = valueWeight * recency;
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

  const totalExecs = weightedCompleted + weightedFailed + weightedCancelled;
  const reliability = totalExecs > 0 ? (weightedCompleted / totalExecs) * 100 : 50;

  const avgDuration = weightedDurationCount > 0 ? weightedDurationSum / weightedDurationCount : 0;
  const speed = Math.max(0, Math.min(100, 100 - (avgDuration / 600) * 100));

  // Liquidity quality: derive from utilization (lower = better).
  const offers = await db.liquidityOffer.findMany({
    where: { providerId },
    select: { availableCapacity: true, reservedCapacity: true, active: true, feeBps: true },
  });
  const activeOffers = offers.filter((o) => o.active);
  const liquidityQuality = activeOffers.length > 0
    ? Math.min(100, 100 - activeOffers.reduce((s, o) => {
        const avail = Number(o.availableCapacity.toString());
        const res = Number(o.reservedCapacity.toString());
        return s + (avail > 0 ? (res / avail) * 100 : 0);
      }, 0) / activeOffers.length)
    : 50;

  // Pricing: competitiveness vs network median fee.
  const medianFee = await getMedianNetworkFee();
  const providerMedianFee = activeOffers.length > 0
    ? activeOffers.reduce((s, o) => s + o.feeBps, 0) / activeOffers.length
    : medianFee;
  const pricing = medianFee > 0
    ? Math.max(0, Math.min(100, 100 - ((providerMedianFee - medianFee) / medianFee) * 50))
    : 50;

  // Disputes: fewer = better.
  const disputeRate = totalExecs > 0 ? disputes / totalExecs : 0;
  const disputesScore = Math.max(0, 100 - disputeRate * 200);

  // Operational: failures not due to disputes.
  const operationalRate = totalExecs > 0 ? weightedFailed / totalExecs : 0;
  const operational = Math.max(0, 100 - operationalRate * 150);

  // History: how long the provider has been active.
  const provider = await db.liquidityProvider.findUnique({
    where: { id: providerId },
    select: { createdAt: true, status: true, tier: true },
  });
  const ageDays = provider ? (now - provider.createdAt.getTime()) / DAY_MS : 0;
  const history = Math.min(100, (ageDays / 90) * 100);

  const overall = Math.round(
    reliability * 0.25 +
    speed * 0.15 +
    liquidityQuality * 0.15 +
    pricing * 0.15 +
    disputesScore * 0.15 +
    operational * 0.10 +
    history * 0.05
  );

  const tier = deriveTier(overall, meaningfulExecutions, ageDays, slashes);
  const tierReason = getTierReason(tier, overall, meaningfulExecutions, ageDays);

  return {
    providerId,
    components: {
      reliability: Math.round(reliability),
      speed: Math.round(speed),
      liquidityQuality: Math.round(liquidityQuality),
      pricing: Math.round(pricing),
      disputes: Math.round(disputesScore),
      operational: Math.round(operational),
      history: Math.round(history),
      overall,
      sampleSize: meaningfulExecutions,
      decayNote: "Anti-gaming: only transactions ≥ $50 count. Weighted by sqrt(value/$100) × recency (<7d=1.0, 7-30d=0.5, 30-90d=0.25).",
    },
    tier,
    tierReason,
  };
}

function decayWeight(ageMs: number): number {
  const days = ageMs / DAY_MS;
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.5;
  if (days <= 90) return 0.25;
  return 0.1;
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

function deriveTier(reputation: number, meaningfulExecs: number, ageDays: number, slashes: number): string {
  if (slashes > 0) return "VERIFIED";
  if (reputation >= 85 && meaningfulExecs >= 10 && ageDays >= 30) return "PREMIUM";
  if (reputation >= 70 && meaningfulExecs >= 5 && ageDays >= 14) return "TRUSTED";
  if (meaningfulExecs >= 1 || ageDays >= 7) return "VERIFIED";
  return "NEW";
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
// Used by the routing engine to look up corridor-specific reputation.
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
