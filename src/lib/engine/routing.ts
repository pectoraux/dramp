// Routing engine — the core of dRamp.
//
// The marketplace is a graph:
//   - nodes are (asset, country) pairs (fiat) or (asset, GLOBAL) for on-chain
//   - edges are active LiquidityOffers published by providers
//
// The engine:
//   1. enumerates simple paths source -> destination up to maxHops
//   2. computes economics along each path (fees, FX, incentives, net output)
//   3. applies HARD filters (provider suspension, capacity, collateral,
//      prohibited assets, asset-risk ceiling, unsupported corridor)
//   4. computes the five separate risk dimensions
//   5. ranks by the user's risk tolerance and tags BEST/CHEAPEST/FASTEST/SAFEST
//   6. supports split routes when no single offer covers the amount
//
// Hard filters NEVER optimize — a route that violates one is invalid.

import { db } from "@/lib/db";
import { Decimal, moneyAdd, moneyMul, bpsToFactor } from "./money";
import {
  computeRouteRisk,
  settlementAssetRisk,
  providerRiskFromRecord,
  settlementAssetRiskFromRecord,
  type RouteRiskResult,
} from "./risk";
import {
  CAPABILITY,
  CHANNEL_TYPE,
  LEG_ROLE,
  ROUTE_TAG,
  SETTLEMENT_ASSET_TYPE,
} from "./types";
import {
  calculateAbsoluteRouteQuality as sharedCalculateAbsoluteRouteQuality,
  shouldReplaceRoute as sharedShouldReplaceRoute,
  computeRouteReputation as sharedComputeRouteReputation,
  computeRouteCommitment as sharedComputeRouteCommitment,
  rankRoutes as sharedRankRoutes,
  applyHardFilters as sharedApplyHardFilters,
  computeHopOutput as sharedComputeHopOutput,
  coverAmount as sharedCoverAmount,
  enumeratePaths as sharedEnumeratePaths,
  ROUTE_REPLACEMENT_THRESHOLD as SHARED_ROUTE_REPLACEMENT_THRESHOLD,
  type RouteInfo as SharedRouteInfo,
  type RouteLegInfo as SharedRouteLegInfo,
  type RouteScoreContext as SharedRouteScoreContext,
  type HardFilterContext as SharedHardFilterContext,
  type HardFilterResult as SharedHardFilterResult,
  type RankedRoute,
  type HopEconomics,
  type CoverOffer,
  type AdjacencyEdge,
  type PathStep as SharedPathStep,
} from "@/lib/economics/shared";

// ---- Graph node helpers --------------------------------------------------

function nodeKey(asset: string, country: string): string {
  return `${asset}:${country}`;
}

export interface GraphNode {
  asset: string;
  country: string;
}

// ---- Leg (candidate, pre-DB) --------------------------------------------

export interface CandidateLeg {
  providerId: string;
  offerId: string;
  offerVersion: number; // observed offer version for optimistic concurrency
  sequence: number; // hop index; parallel legs share a sequence
  role: string; // SOURCE | SETTLEMENT_HOP | DESTINATION
  amount: Decimal; // input amount in this leg's source asset
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  settlementAssetId: string | null;
  channelType: string;
  feeBps: number;
  incentiveBps: number;
  rate: Decimal;
  expectedExecutionSeconds: number;
  // risk inputs
  providerRisk: ReturnType<typeof providerRiskFromRecord>;
  offerCapacity: Decimal;
  settlementAssetRisk: ReturnType<typeof settlementAssetRiskFromRecord> | null;
}

export interface CandidateRoute {
  legs: CandidateLeg[];
  hopCount: number;
  split: boolean;
  totalCost: Decimal; // source-asset terms (approx)
  effectiveCost: Decimal; // source-asset terms (approx, net of incentives)
  grossOutput: Decimal; // notional output ignoring fees
  netOutput: Decimal; // actual destination amount
  incentiveBps: number;
  risk: RouteRiskResult;
  expectedExecutionSeconds: number;
  explanation: string;
  tag: string;
  hardFilterRejection?: string;
}

// ---- Path enumeration ----------------------------------------------------

interface AdjEdge {
  to: string; // node key
  offer: {
    id: string;
    providerId: string;
    capability: string;
    sourceAsset: string;
    destinationAsset: string;
    sourceCountry: string;
    destinationCountry: string;
    rate: Decimal;
    feeBps: number;
    minimumAmount: Decimal;
    maximumAmount: Decimal;
    availableCapacity: Decimal;
    reservedCapacity: Decimal;
    settlementAssetId: string | null;
    channelType: string;
    expectedExecutionSeconds: number;
    incentiveBps: number;
    active: boolean;
    expiresAt: Date | null;
    version: number;
  };
  provider: {
    id: string;
    name: string;
    providerType: string;
    trustModel: string;
    capabilities: string;
    countries: string;
    reputationScore: number;
    status: string;
    vaultId: string | null;
  };
}

async function buildGraph(): Promise<Map<string, AdjEdge[]>> {
  const offers = await db.liquidityOffer.findMany({
    where: { active: true },
    include: { provider: true },
  });
  // Enrich offers with active settlement-incentive campaigns. The offer's own
  // incentiveBps is the base; the campaign incentive is added if the campaign
  // is active, within its date window, and has remaining budget. This reuses
  // the existing incentive integration in computeHopOutput — no parallel
  // pricing system.
  const { getApplicableIncentiveBps } = await import("@/lib/provider-api/incentives");
  const adj = new Map<string, AdjEdge[]>();
  const now = new Date();
  for (const o of offers) {
    if (o.expiresAt && o.expiresAt < now) continue;
    if (o.provider.status !== "ACTIVE") continue;
    // Compute the effective incentive: base offer incentive + active campaign.
    let effectiveIncentiveBps = o.incentiveBps;
    if (o.settlementAssetId) {
      const { bps } = await getApplicableIncentiveBps(o.settlementAssetId, {
        sourceAsset: o.sourceAsset,
        destinationAsset: o.destinationAsset,
        riskTolerance: "", // campaigns don't filter by risk at graph-build time
        providerType: o.provider.providerType,
      });
      effectiveIncentiveBps += bps;
    }
    const from = nodeKey(o.sourceAsset, o.sourceCountry);
    const to = nodeKey(o.destinationAsset, o.destinationCountry);
    const edge: AdjEdge = {
      to,
      offer: {
        id: o.id,
        providerId: o.providerId,
        capability: o.capability,
        sourceAsset: o.sourceAsset,
        destinationAsset: o.destinationAsset,
        sourceCountry: o.sourceCountry,
        destinationCountry: o.destinationCountry,
        rate: o.rate,
        feeBps: o.feeBps,
        minimumAmount: o.minimumAmount,
        maximumAmount: o.maximumAmount,
        availableCapacity: o.availableCapacity,
        reservedCapacity: o.reservedCapacity,
        settlementAssetId: o.settlementAssetId,
        channelType: o.channelType,
        expectedExecutionSeconds: o.expectedExecutionSeconds,
        incentiveBps: effectiveIncentiveBps,
        active: o.active,
        expiresAt: o.expiresAt,
        version: o.version,
      },
      provider: {
        id: o.provider.id,
        name: o.provider.name,
        providerType: o.provider.providerType,
        trustModel: o.provider.trustModel,
        capabilities: o.provider.capabilities,
        countries: o.provider.countries,
        reputationScore: o.provider.reputationScore,
        status: o.provider.status,
        vaultId: o.provider.vaultId,
      },
    };
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push(edge);
  }
  return adj;
}

// ---- Path enumeration ----------------------------------------------------
//
// Delegates the DFS simple-path enumeration to the canonical shared function.
// Production wraps it with its own AdjEdge type; the path-search logic itself
// (visited-set, maxHops cutoff, parallel-edge grouping) lives in shared.ts.
// No duplicate path-search code.

type PathStep = SharedPathStep<AdjEdge>;

function enumeratePaths(adj: Map<string, AdjEdge[]>, source: string, dest: string, maxHops: number): PathStep[][] {
  // Convert production's adjacency map (node -> AdjEdge[]) to the shared shape
  // (node -> AdjacencyEdge<AdjEdge>[]). The edge payload is preserved verbatim.
  const sharedAdj: Map<string, AdjacencyEdge<AdjEdge>[]> = new Map();
  for (const [node, edges] of adj.entries()) {
    sharedAdj.set(
      node,
      edges.map((e) => ({ to: e.to, edge: e })),
    );
  }
  return sharedEnumeratePaths(sharedAdj, source, dest, maxHops);
}

// ---- Cover an amount across one hop's offers (split support) -------------
//
// Delegates the split-capacity assignment logic to the canonical shared
// function. Production converts Decimal <-> number at the boundary and maps
// offerId back to the full AdjEdge. No duplicate cover logic.

interface LegAssignment {
  edge: AdjEdge;
  amount: Decimal; // input amount assigned to this offer
}

function coverAmount(edges: AdjEdge[], amount: Decimal): { assignments: LegAssignment[]; split: boolean } | null {
  const coverOffers: CoverOffer[] = edges.map((e) => ({
    id: e.offer.id,
    channelType: e.offer.channelType,
    feeBps: e.offer.feeBps,
    availableCapacity: e.offer.availableCapacity.toNumber(),
    reservedCapacity: e.offer.reservedCapacity.toNumber(),
    minimumAmount: e.offer.minimumAmount.toNumber(),
  }));
  const result = sharedCoverAmount(coverOffers, amount.toNumber());
  if (!result) return null;
  // Map offerId back to the full AdjEdge.
  const edgeById = new Map(edges.map((e) => [e.offer.id, e] as const));
  const assignments: LegAssignment[] = result.assignments.map((a) => ({
    edge: edgeById.get(a.offerId)!,
    amount: new Decimal(a.amount),
  }));
  return { assignments, split: result.split };
}

// ---- Economics computation ----------------------------------------------
//
// Delegates the hop-output formula (fee + FX + incentive) to the canonical
// shared function. Production converts Decimal <-> number at the boundary.
// For dRamp magnitudes (<= ~$1M) float64 gives ~1e-10 dollar precision — far
// below the cent and below MONETARY_EPSILON (0.01). No duplicate formula.

function computeHopOutput(inputAmount: Decimal, edge: AdjEdge): { output: Decimal; fee: Decimal; incentive: Decimal } {
  const econ: HopEconomics = {
    feeBps: edge.offer.feeBps,
    rate: edge.offer.rate.toNumber(),
    incentiveBps: edge.offer.incentiveBps,
  };
  const result = sharedComputeHopOutput(inputAmount.toNumber(), econ);
  return {
    output: new Decimal(result.output),
    fee: new Decimal(result.fee),
    incentive: new Decimal(result.incentive),
  };
}

// ---- Build a candidate route from a path --------------------------------

async function buildCandidateRoute(
  path: PathStep[],
  sourceAmount: Decimal,
  sourceAsset: string,
  destAsset: string,
  settlementAssets: Map<string, Awaited<ReturnType<typeof db.settlementAsset.findMany>>[number]>,
  providers: Map<string, Awaited<ReturnType<typeof db.liquidityProvider.findMany>>[number]>,
): Promise<CandidateRoute | null> {
  const legs: CandidateLeg[] = [];
  let currentAmount = sourceAmount;
  let totalFeeBps = 0;
  let totalIncentiveBps = 0;
  let split = false;
  const hopCount = path.length;
  let expectedSeconds = 0;

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const cover = coverAmount(step.edges, currentAmount);
    if (!cover) return null; // hard filter: insufficient capacity
    if (cover.split) split = true;

    let hopOutput = new Decimal(0);
    for (const a of cover.assignments) {
      const e = a.edge;
      const { output, fee, incentive } = computeHopOutput(a.amount, e);
      hopOutput = moneyAdd(hopOutput, output);
      const role =
        i === 0 && i === hopCount - 1
          ? LEG_ROLE.SOURCE // single-hop route
          : i === 0
            ? LEG_ROLE.SOURCE
            : i === hopCount - 1
              ? LEG_ROLE.DESTINATION
              : LEG_ROLE.SETTLEMENT_HOP;

      const provRec = providers.get(e.offer.providerId) ?? {
        trustModel: e.provider.trustModel,
        providerType: e.provider.providerType,
        reputationScore: e.provider.reputationScore,
        status: e.provider.status,
      };
      const saRec = e.offer.settlementAssetId
        ? settlementAssets.get(e.offer.settlementAssetId) ?? null
        : null;
      // Also consider the destination asset of this hop if it's a settlement asset.
      const destSa = settlementAssetsBySymbol(step.toNode.split(":")[0], settlementAssets);

      legs.push({
        providerId: e.offer.providerId,
        offerId: e.offer.id,
        sequence: i,
        role,
        amount: a.amount,
        sourceAsset: e.offer.sourceAsset,
        destinationAsset: e.offer.destinationAsset,
        sourceCountry: e.offer.sourceCountry,
        destinationCountry: e.offer.destinationCountry,
        settlementAssetId: e.offer.settlementAssetId ?? destSa?.id ?? null,
        channelType: e.offer.channelType,
        feeBps: e.offer.feeBps,
        incentiveBps: e.offer.incentiveBps,
        rate: e.offer.rate,
        expectedExecutionSeconds: e.offer.expectedExecutionSeconds,
        offerVersion: e.offer.version,
        providerRisk: providerRiskFromRecord(provRec),
        offerCapacity: e.offer.availableCapacity,
        settlementAssetRisk: saRec
          ? settlementAssetRiskFromRecord(saRec)
          : destSa
            ? settlementAssetRiskFromRecord(destSa)
            : null,
      });
      totalFeeBps += e.offer.feeBps;
      totalIncentiveBps += e.offer.incentiveBps;
    }
    expectedSeconds = Math.max(expectedSeconds, cover.assignments.reduce((s, a) => Math.max(s, a.edge.offer.expectedExecutionSeconds), 0));
    currentAmount = hopOutput;
  }

  const netOutput = currentAmount;
  // Gross output: notional with rate product and no fees.
  let gross = sourceAmount;
  for (let i = 0; i < path.length; i++) {
    // use the first edge's rate as representative for gross calc
    const edge = path[i].edges[0];
    if (edge) gross = moneyMul(gross, edge.offer.rate);
  }
  const effectiveCostBps = Math.max(0, totalFeeBps - totalIncentiveBps);
  const totalCost = moneyMul(sourceAmount, bpsToFactor(totalFeeBps));
  const effectiveCost = moneyMul(sourceAmount, bpsToFactor(effectiveCostBps));

  const risk = computeRouteRisk(
    legs.map((l) => ({
      provider: l.providerRisk,
      channelType: l.channelType,
      offerCapacity: l.offerCapacity,
      legAmount: l.amount,
      settlementAsset: l.settlementAssetRisk ?? undefined,
      expectedExecutionSeconds: l.expectedExecutionSeconds,
    })),
  );

  return {
    legs,
    hopCount,
    split,
    totalCost,
    effectiveCost,
    grossOutput: gross,
    netOutput,
    incentiveBps: totalIncentiveBps,
    risk,
    expectedExecutionSeconds: expectedSeconds,
    explanation: "",
    tag: ROUTE_TAG.CANDIDATE,
  };
}

function settlementAssetsBySymbol(
  symbol: string,
  map: Map<string, Awaited<ReturnType<typeof db.settlementAsset.findMany>>[number]>,
) {
  for (const a of map.values()) {
    if (a.symbol === symbol) return a;
  }
  return null;
}

// ---- Hard filters --------------------------------------------------------
//
// Delegates to the canonical shared.applyHardFilters. The shared function
// operates on plain-number RouteInfo; we convert CandidateRoute → RouteInfo
// at the boundary. No formula is duplicated.

export interface HardFilterContext {
  riskTolerance: string;
  prohibitedSettlementAssets: string[]; // asset ids
  allowedSettlementAssets: string[]; // asset ids (empty = all eligible)
  minimumLiquidityUtilization?: number; // legacy, unused (capacity checked in shared)
}

function applyHardFilters(route: CandidateRoute, ctx: HardFilterContext): CandidateRoute {
  const sharedCtx: SharedHardFilterContext = {
    riskTolerance: ctx.riskTolerance,
    prohibitedSettlementAssets: ctx.prohibitedSettlementAssets,
    allowedSettlementAssets: ctx.allowedSettlementAssets,
  };
  const result: SharedHardFilterResult = sharedApplyHardFilters(candidateRouteToRouteInfo(route), sharedCtx);
  if (result.rejectionReason) {
    route.hardFilterRejection = result.rejectionReason;
  }
  return route;
}

function requireSettlementAssetRisk(input: ReturnType<typeof settlementAssetRiskFromRecord>): number {
  return settlementAssetRisk(input);
}

// ---- CandidateRoute → shared RouteInfo conversion -------------------------
//
// Production uses Decimal for money; the shared pure functions use number.
// We convert at the boundary. Risk thresholds (0.3, 0.5, 0.7, 0.9) are coarse
// enough that float64 is more than sufficient.

function candidateRouteToRouteInfo(route: CandidateRoute): SharedRouteInfo {
  return {
    legs: route.legs.map((l): SharedRouteLegInfo => ({
      providerId: l.providerId,
      sourceAsset: l.sourceAsset,
      destinationAsset: l.destinationAsset,
      sourceCountry: l.sourceCountry ?? "",
      destinationCountry: l.destinationCountry ?? "",
      role: l.role ?? "SOURCE",
      amount: l.amount?.toNumber?.() ?? (typeof l.amount === "number" ? l.amount : 0),
      feeBps: l.feeBps ?? 0,
      channelType: l.channelType ?? "AUTOMATIC",
      offerCapacity: l.offerCapacity?.toNumber?.() ?? (typeof l.offerCapacity === "number" ? l.offerCapacity : 0),
      expectedExecutionSeconds: l.expectedExecutionSeconds ?? 60,
      settlementAssetId: l.settlementAssetId,
      // Defensive: test mocks and historical routes may not have risk inputs.
      // Scoring functions (calculateAbsoluteRouteQuality, computeRouteReputation,
      // computeRouteCommitment) don't use these; only applyHardFilters + computeRouteRisk do.
      provider: l.providerRisk ?? { trustModel: "NON_CUSTODIAL", providerType: "HYBRID", reputationScore: 0.5, status: "ACTIVE" },
      settlementAsset: l.settlementAssetRisk ?? undefined,
    })),
    effectiveCost: route.effectiveCost?.toNumber?.() ?? (typeof route.effectiveCost === "number" ? route.effectiveCost : 0),
    expectedExecutionSeconds: route.expectedExecutionSeconds,
    riskComposite: route.risk?.composite ?? 0.5,
    risk: route.risk,
  };
}

// ---- Ranking & tagging ---------------------------------------------------
//
// Delegates the candidate-set-relative scoring to shared.rankRoutes. The
// shared function normalizes cost/speed/risk/reputation across the current
// candidate set and assigns BEST/CHEAPEST/FASTEST/SAFEST tags. Production
// adds explanation strings on top (UI-facing, not a pure calculation).

function rankAndTag(routes: CandidateRoute[], riskTolerance: string, reputationMap?: Map<string, number>, corridorScores?: Map<string, number>, commitmentReliability?: Map<string, number>): CandidateRoute[] {
  const valid = routes.filter((r) => !r.hardFilterRejection);
  if (valid.length === 0) return routes;

  const ctx: SharedRouteScoreContext = { riskTolerance, reputationMap, corridorScores, commitmentReliability };

  // Build pairs so we can map shared RankedRoute results back to CandidateRoute.
  const pairs = valid.map((r) => ({ candidate: r, info: candidateRouteToRouteInfo(r) }));
  const ranked: RankedRoute[] = sharedRankRoutes(pairs.map((p) => p.info), ctx);

  // Map tags back using object identity (RouteInfo objects are fresh/unique).
  const infoToCandidate = new Map<SharedRouteInfo, CandidateRoute>();
  for (const p of pairs) infoToCandidate.set(p.info, p.candidate);
  for (const rr of ranked) {
    const c = infoToCandidate.get(rr.route);
    if (c) c.tag = rr.tag;
  }

  // Identify extremes for explanation generation.
  const cheapest = valid.reduce((m, r) => r.effectiveCost.lt(m.effectiveCost) ? r : m, valid[0]);
  const fastest = valid.reduce((m, r) => r.expectedExecutionSeconds < m.expectedExecutionSeconds ? r : m, valid[0]);
  const safest = valid.reduce((m, r) => r.risk.composite < m.risk.composite ? r : m, valid[0]);
  const best = infoToCandidate.get(ranked[0].route) ?? valid[0];

  for (const r of valid) {
    r.explanation = explainRoute(r, valid, { cheapest, fastest, safest, best });
  }

  // Order: best first, then cheapest, fastest, safest, then others.
  const tagOrder: Record<string, number> = {
    [ROUTE_TAG.BEST]: 0,
    [ROUTE_TAG.CHEAPEST]: 1,
    [ROUTE_TAG.FASTEST]: 2,
    [ROUTE_TAG.SAFEST]: 3,
    [ROUTE_TAG.CANDIDATE]: 4,
  };
  valid.sort((a, b) => (tagOrder[a.tag] ?? 9) - (tagOrder[b.tag] ?? 9));
  const rejected = routes.filter((r) => r.hardFilterRejection);
  return [...valid, ...rejected];
}

// ---- Shared route scoring (delegates to canonical shared.ts) ---------------
//
// All pure route quality calculations live in src/lib/economics/shared.ts.
// These wrappers convert CandidateRoute (Decimal) → RouteInfo (number) and
// delegate. No formula is duplicated here.

export type RouteScoreContext = SharedRouteScoreContext;

export function scoreRoute(route: CandidateRoute, ctx: RouteScoreContext): number {
  return sharedCalculateAbsoluteRouteQuality(candidateRouteToRouteInfo(route), ctx);
}

export function calculateAbsoluteRouteQuality(route: CandidateRoute, ctx: RouteScoreContext): number {
  return sharedCalculateAbsoluteRouteQuality(candidateRouteToRouteInfo(route), ctx);
}

export function computeRouteReputation(route: CandidateRoute, ctx: RouteScoreContext): number {
  return sharedComputeRouteReputation(candidateRouteToRouteInfo(route), ctx);
}

export function computeRouteCommitment(route: CandidateRoute, ctx: RouteScoreContext): number {
  return sharedComputeRouteCommitment(candidateRouteToRouteInfo(route), ctx);
}

export const ROUTE_REPLACEMENT_THRESHOLD = SHARED_ROUTE_REPLACEMENT_THRESHOLD;

export function shouldReplaceRoute(
  newRoute: CandidateRoute,
  refRoute: CandidateRoute,
  ctx: RouteScoreContext,
): { replace: boolean; improvement: number; reason: string } {
  if (newRoute.hardFilterRejection) return { replace: false, improvement: 0, reason: "new route rejected by hard filter" };
  if (refRoute.hardFilterRejection) return { replace: true, improvement: 1, reason: "reference route rejected" };
  return sharedShouldReplaceRoute(candidateRouteToRouteInfo(newRoute), candidateRouteToRouteInfo(refRoute), ctx);
}

function explainRoute(
  r: CandidateRoute,
  all: CandidateRoute[],
  refs: { cheapest: CandidateRoute; fastest: CandidateRoute; safest: CandidateRoute; best: CandidateRoute },
): string {
  const parts: string[] = [];
  const labelMap: Record<string, string> = {
    [ROUTE_TAG.BEST]: "Best overall",
    [ROUTE_TAG.CHEAPEST]: "Lowest cost",
    [ROUTE_TAG.FASTEST]: "Fastest",
    [ROUTE_TAG.SAFEST]: "Safest",
    [ROUTE_TAG.CANDIDATE]: "Candidate route",
  };
  parts.push(labelMap[r.tag] ?? "Candidate route");

  // Cost comparison vs next-best
  const others = all.filter((x) => x !== r).sort((a, b) => a.effectiveCost.minus(b.effectiveCost).toNumber());
  if (others.length > 0 && r.effectiveCost.lt(others[0].effectiveCost)) {
    const diffBps = others[0].effectiveCost.minus(r.effectiveCost).dividedBy(r.legs[0]?.amount ?? 1).times(10000).toNumber();
    if (diffBps > 0) parts.push(`${(diffBps / 100).toFixed(2)}% cheaper than next-best route`);
  }

  // Channel
  const hasManual = r.legs.some((l) => l.channelType === CHANNEL_TYPE.MANUAL);
  parts.push(hasManual ? "Manual confirmation required" : "Automatic payout");

  // Settlement asset quality
  const saRisks = r.legs.map((l) => l.settlementAssetRisk).filter(Boolean);
  if (saRisks.length > 0) {
    const maxSa = Math.max(...saRisks.map((s) => requireSettlementAssetRisk(s!)));
    if (maxSa < 0.2) parts.push("Established settlement asset");
    else if (maxSa < 0.45) parts.push("Solid settlement asset");
    else parts.push("Emerging settlement asset (higher settlement-asset risk)");
  }

  // Liquidity
  if (r.risk.liquidity < 0.3) parts.push("High liquidity");
  else if (r.risk.liquidity < 0.6) parts.push("Adequate liquidity");
  else parts.push("Lower liquidity");

  // Provider reliability (from the first leg's provider risk)
  if (r.risk.counterparty < 0.2) parts.push("High provider reliability");
  else if (r.risk.counterparty < 0.4) parts.push("Good provider reliability");

  // Hops
  if (r.hopCount > 1) parts.push(`${r.hopCount} hops`);
  if (r.split) parts.push("Split across multiple providers");

  // Incentive
  if (r.incentiveBps > 0) parts.push(`${(r.incentiveBps / 100).toFixed(2)}% settlement incentive`);

  parts.push(`Estimated execution: ${formatDuration(r.expectedExecutionSeconds)}`);
  return parts.join(" • ");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}m ${s}s` : `${m} minute${m > 1 ? "s" : ""}`;
}

// ---- Top-level orchestrator ---------------------------------------------

export interface FindRoutesInput {
  sourceAmount: Decimal | string | number;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  riskTolerance: string;
  allowedSettlementAssets: string[];
  prohibitedSettlementAssets: string[];
  maxHops?: number;
}

export async function findRoutes(input: FindRoutesInput): Promise<CandidateRoute[]> {
  const adj = await buildGraph();
  const source = nodeKey(input.sourceAsset, input.sourceCountry);
  const dest = nodeKey(input.destinationAsset, input.destinationCountry);
  const maxHops = input.maxHops ?? 4;

  const paths = enumeratePaths(adj, source, dest, maxHops);
  if (paths.length === 0) return [];

  const settlementAssets = await db.settlementAsset.findMany();
  const saMap = new Map(settlementAssets.map((s) => [s.id, s] as const));
  const providers = await db.liquidityProvider.findMany();
  const provMap = new Map(providers.map((p) => [p.id, p] as const));

  const candidates: CandidateRoute[] = [];
  for (const path of paths) {
    const c = await buildCandidateRoute(
      path,
      new Decimal(input.sourceAmount),
      input.sourceAsset,
      input.destinationAsset,
      saMap,
      provMap,
    );
    if (c) candidates.push(c);
  }

  // Apply hard filters
  const ctx: HardFilterContext = {
    riskTolerance: input.riskTolerance,
    prohibitedSettlementAssets: input.prohibitedSettlementAssets,
    allowedSettlementAssets: input.allowedSettlementAssets,
  };
  const filtered = candidates.map((c) => applyHardFilters(c, ctx));

  // Fetch provider reputation + corridor scores + commitment reliability for
  // ranking integration. All are modest factors that nudge ranking but never
  // override hard constraints.
  let reputationMap: Map<string, number> | undefined;
  let corridorScoreMap: Map<string, number> | undefined;
  let commitmentReliabilityMap: Map<string, number> | undefined;
  try {
    const { getReputationMap, getCorridorScoreMap } = await import("@/lib/economics/reputation");
    const { getCommitmentReliabilityMap } = await import("@/lib/economics/commitments");
    reputationMap = await getReputationMap();
    corridorScoreMap = await getCorridorScoreMap();
    commitmentReliabilityMap = await getCommitmentReliabilityMap();
  } catch {
    // If reputation service is unavailable, fall back to neutral scores.
  }

  // Rank and tag (with reputation + corridor + commitment as factors)
  return rankAndTag(filtered, input.riskTolerance, reputationMap, corridorScoreMap, commitmentReliabilityMap);
}

// Quick helper that delegates to shouldReplaceRoute. This is kept for
// backward compatibility but the canonical path is shouldReplaceRoute.
export function isBetterRoute(
  newRoute: CandidateRoute,
  refRoute: CandidateRoute,
  riskTolerance: string,
  ctx?: RouteScoreContext,
): boolean {
  const scoreCtx: RouteScoreContext = ctx ?? { riskTolerance };
  return shouldReplaceRoute(newRoute, refRoute, scoreCtx).replace;
}

// ---- Persisted route reconstruction (Prompt 3.3 + 3.4) --------------------
//
// Rebuilds a real CandidateRoute from a persisted Route + Leg[] with all
// material fields needed for scoring: provider IDs, corridors, amounts,
// risk dimensions, etc. No fake provider IDs or empty fields.
//
// Prompt 3.4: Uses the LEG'S OWN SNAPSHOT FIELDS (snapshotFeeBps,
// snapshotSourceCountry, etc.) rather than the current mutable LiquidityOffer.
// This ensures the reconstructed route represents the route that existed when
// it was selected — not whatever the provider currently advertises.

export async function reconstructPersistedRoute(routeId: string): Promise<CandidateRoute | null> {
  const route = await db.route.findUnique({
    where: { id: routeId },
    include: { legs: { include: { provider: true } } },
  });
  if (!route) return null;

  const legs: CandidateLeg[] = route.legs
    .sort((a, b) => a.sequence - b.sequence)
    .map((l) => ({
      providerId: l.providerId,
      offerId: l.offerId,
      offerVersion: l.snapshotOfferVersion ?? 1,
      sequence: l.sequence,
      role: l.role,
      amount: l.amount,
      sourceAsset: l.sourceAsset,
      destinationAsset: l.destinationAsset,
      // Use the leg's historical snapshot, not the mutable offer.
      sourceCountry: l.snapshotSourceCountry ?? "GLOBAL",
      destinationCountry: l.snapshotDestinationCountry ?? "GLOBAL",
      settlementAssetId: l.settlementAssetId,
      channelType: l.channelType,
      feeBps: l.snapshotFeeBps ?? 0,
      incentiveBps: l.snapshotIncentiveBps ?? 0,
      rate: l.snapshotRate ?? new Decimal(1),
      expectedExecutionSeconds: l.snapshotExpectedExecutionSeconds ?? 60,
      providerRisk: providerRiskFromRecord(l.provider ? {
        trustModel: l.provider.trustModel,
        providerType: l.provider.providerType,
        reputationScore: l.provider.reputationScore,
        status: l.provider.status,
      } : { trustModel: "NON_CUSTODIAL", providerType: "HYBRID", reputationScore: 0.5, status: "ACTIVE" }),
      offerCapacity: new Decimal(0), // not needed for historical scoring
      settlementAssetRisk: null,
    }));

  return {
    legs,
    hopCount: route.legCount,
    split: route.splitRoute,
    totalCost: route.totalCost,
    effectiveCost: route.effectiveCost,
    grossOutput: route.grossOutput,
    netOutput: route.netOutput,
    incentiveBps: route.incentiveBps,
    risk: {
      counterparty: route.riskCounterparty,
      settlementAsset: route.riskSettlementAsset,
      liquidity: route.riskLiquidity,
      operational: route.riskOperational,
      duration: route.riskDuration,
      composite: route.riskComposite,
    },
    expectedExecutionSeconds: route.expectedExecutionSeconds,
    explanation: route.explanation,
    tag: route.tag,
    hardFilterRejection: undefined,
  };
}
