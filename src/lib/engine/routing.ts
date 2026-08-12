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
import { Decimal, moneyAdd, moneySub, moneyMul, moneyGte, moneyLte, moneyGt, moneyLt, moneyMin, moneyMax, bpsToFactor, feeForAmount, incentiveForAmount } from "./money";
import {
  computeRouteRisk,
  providerCounterpartyRisk,
  settlementAssetRisk,
  providerRiskFromRecord,
  settlementAssetRiskFromRecord,
  assetRiskCeiling,
  counterpartyRiskCeiling,
  type RouteRiskResult,
} from "./risk";
import {
  CAPABILITY,
  CHANNEL_TYPE,
  LEG_ROLE,
  ROUTE_TAG,
  SETTLEMENT_ASSET_TYPE,
} from "./types";

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

interface PathStep {
  fromNode: string;
  toNode: string;
  edges: AdjEdge[]; // offers that can serve this hop (parallel candidates)
}

// Enumerate simple paths (no repeated nodes) up to maxHops.
function enumeratePaths(adj: Map<string, AdjEdge[]>, source: string, dest: string, maxHops: number): PathStep[][] {
  const results: PathStep[][] = [];
  const visited = new Set<string>([source]);

  function dfs(current: string, path: PathStep[]) {
    if (path.length > 0 && current === dest) {
      results.push([...path]);
      return;
    }
    if (path.length >= maxHops) return;
    const edges = adj.get(current) ?? [];
    for (const e of edges) {
      if (visited.has(e.to)) continue;
      // Don't allow arriving at dest with 0 hops; also avoid trivial self-loops.
      visited.add(e.to);
      path.push({ fromNode: current, toNode: e.to, edges: edges.filter((x) => x.to === e.to) });
      dfs(e.to, path);
      path.pop();
      visited.delete(e.to);
    }
  }
  dfs(source, []);
  return results;
}

// ---- Cover an amount across one hop's offers (split support) -------------

interface LegAssignment {
  edge: AdjEdge;
  amount: Decimal; // input amount assigned to this offer
}

// Assign the input amount across available offers for a hop.
// Returns a single assignment if one offer can cover it, otherwise a split.
// Returns null if combined capacity is insufficient (hard filter).
function coverAmount(edges: AdjEdge[], amount: Decimal): { assignments: LegAssignment[]; split: boolean } | null {
  // Filter to offers that satisfy min amount (for single) and have capacity.
  const usable = edges
    .filter((e) => moneyGt(e.offer.availableCapacity, 0))
    .sort((a, b) => {
      // Prefer automatic, lower fee, higher capacity.
      if (a.offer.channelType !== b.offer.channelType) {
        return a.offer.channelType === CHANNEL_TYPE.AUTOMATIC ? -1 : 1;
      }
      if (a.offer.feeBps !== b.offer.feeBps) return a.offer.feeBps - b.offer.feeBps;
      return new Decimal(b.offer.availableCapacity).minus(new Decimal(a.offer.availableCapacity)).toNumber();
    });

  // Try a single offer first.
  for (const e of usable) {
    const avail = moneySub(e.offer.availableCapacity, e.offer.reservedCapacity);
    if (moneyGte(avail, amount) && moneyGte(amount, e.offer.minimumAmount)) {
      return { assignments: [{ edge: e, amount }], split: false };
    }
  }
  // Otherwise split across multiple offers.
  const assignments: LegAssignment[] = [];
  let remaining = amount;
  for (const e of usable) {
    if (moneyLte(remaining, 0)) break;
    const avail = moneySub(e.offer.availableCapacity, e.offer.reservedCapacity);
    if (moneyLte(avail, 0)) continue;
    const take = moneyMin(remaining, avail);
    if (moneyLt(take, e.offer.minimumAmount)) continue;
    assignments.push({ edge: e, amount: take });
    remaining = moneySub(remaining, take);
  }
  if (moneyGt(remaining, 0)) return null; // insufficient combined capacity
  return { assignments, split: assignments.length > 1 };
}

// ---- Economics computation ----------------------------------------------

function computeHopOutput(inputAmount: Decimal, edge: AdjEdge): { output: Decimal; fee: Decimal; incentive: Decimal } {
  const fee = feeForAmount(inputAmount, edge.offer.feeBps);
  const afterFee = moneySub(inputAmount, fee);
  const converted = moneyMul(afterFee, edge.offer.rate);
  const incentive = incentiveForAmount(converted, edge.offer.incentiveBps);
  // Incentive is a rebate — it increases the effective output (subsidized).
  const output = moneyAdd(converted, incentive);
  return { output, fee, incentive };
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

export interface HardFilterContext {
  riskTolerance: string;
  prohibitedSettlementAssets: string[]; // asset ids
  allowedSettlementAssets: string[]; // asset ids (empty = all eligible)
  minimumLiquidityUtilization?: number; // reject if any leg utilization above this
}

function applyHardFilters(route: CandidateRoute, ctx: HardFilterContext): CandidateRoute {
  for (const leg of route.legs) {
    // Provider suspension
    if (leg.providerRisk.status !== "ACTIVE") {
      route.hardFilterRejection = "Provider suspended";
      return route;
    }
    // Prohibited settlement asset
    if (leg.settlementAssetId && ctx.prohibitedSettlementAssets.includes(leg.settlementAssetId)) {
      route.hardFilterRejection = "Uses a prohibited settlement asset";
      return route;
    }
    // Allowed settlement asset whitelist
    if (
      leg.settlementAssetId &&
      ctx.allowedSettlementAssets.length > 0 &&
      !ctx.allowedSettlementAssets.includes(leg.settlementAssetId)
    ) {
      route.hardFilterRejection = "Settlement asset not in allow-list";
      return route;
    }
    // Asset risk ceiling
    if (leg.settlementAssetRisk) {
      const ceiling = assetRiskCeiling(ctx.riskTolerance);
      // Compute the actual risk for this asset
      const r = settlementAssetRisk(leg.settlementAssetRisk);
      if (r > ceiling) {
        route.hardFilterRejection = `Settlement-asset risk ${r.toFixed(2)} exceeds ceiling ${ceiling.toFixed(2)} for ${ctx.riskTolerance}`;
        return route;
      }
    }
    // Counterparty risk ceiling
    const cpr = providerCounterpartyRisk(leg.providerRisk);
    if (cpr > counterpartyRiskCeiling(ctx.riskTolerance)) {
      route.hardFilterRejection = `Counterparty risk ${cpr.toFixed(2)} exceeds ceiling for ${ctx.riskTolerance}`;
      return route;
    }
    // Minimum capacity (utilization)
    const util = new Decimal(leg.amount).dividedBy(new Decimal(leg.offerCapacity)).toNumber();
    if (util > 1) {
      route.hardFilterRejection = "Insufficient capacity";
      return route;
    }
  }
  return route;
}

function requireSettlementAssetRisk(input: ReturnType<typeof settlementAssetRiskFromRecord>): number {
  return settlementAssetRisk(input);
}

// ---- Ranking & tagging ---------------------------------------------------

function rankAndTag(routes: CandidateRoute[], riskTolerance: string): CandidateRoute[] {
  const valid = routes.filter((r) => !r.hardFilterRejection);
  if (valid.length === 0) return routes;

  const cheapest = [...valid].sort((a, b) => a.effectiveCost.minus(b.effectiveCost).toNumber())[0];
  const fastest = [...valid].sort((a, b) => a.expectedExecutionSeconds - b.expectedExecutionSeconds)[0];
  const safest = [...valid].sort((a, b) => a.risk.composite - b.risk.composite)[0];

  // Best: weighted by risk tolerance
  const weights = weightFor(riskTolerance);
  const scored = valid.map((r) => {
    // Normalize each axis to 0..1 across the candidate set.
    const costMax = valid.reduce((m, x) => moneyMax(m, x.effectiveCost), new Decimal(0)).toNumber() || 1;
    const costMin = valid.reduce((m, x) => moneyMin(m, x.effectiveCost), cheapest.effectiveCost).toNumber();
    const durMax = Math.max(...valid.map((x) => x.expectedExecutionSeconds)) || 1;
    const durMin = fastest.expectedExecutionSeconds;
    const riskMax = Math.max(...valid.map((x) => x.risk.composite)) || 1;
    const riskMin = safest.risk.composite;
    const normCost = costMax === costMin ? 0 : (r.effectiveCost.toNumber() - costMin) / (costMax - costMin);
    const normDur = durMax === durMin ? 0 : (r.expectedExecutionSeconds - durMin) / (durMax - durMin);
    const normRisk = riskMax === riskMin ? 0 : (r.risk.composite - riskMin) / (riskMax - riskMin);
    // score = 1 - weighted penalty (higher is better)
    const penalty = weights.cost * normCost + weights.speed * normDur + weights.risk * normRisk;
    return { route: r, score: 1 - penalty };
  });
  const best = scored.sort((a, b) => b.score - a.score)[0].route;

  for (const r of valid) {
    if (r === best) r.tag = ROUTE_TAG.BEST;
    else if (r === cheapest) r.tag = ROUTE_TAG.CHEAPEST;
    else if (r === fastest) r.tag = ROUTE_TAG.FASTEST;
    else if (r === safest) r.tag = ROUTE_TAG.SAFEST;
    else r.tag = ROUTE_TAG.CANDIDATE;
    r.explanation = explainRoute(r, valid, { cheapest, fastest, safest, best });
  }
  // Order: best first, then cheapest, fastest, safest, then others by score
  const tagOrder: Record<string, number> = {
    [ROUTE_TAG.BEST]: 0,
    [ROUTE_TAG.CHEAPEST]: 1,
    [ROUTE_TAG.FASTEST]: 2,
    [ROUTE_TAG.SAFEST]: 3,
    [ROUTE_TAG.CANDIDATE]: 4,
  };
  valid.sort((a, b) => (tagOrder[a.tag] ?? 9) - (tagOrder[b.tag] ?? 9));
  // Append rejected routes at the end for transparency
  const rejected = routes.filter((r) => r.hardFilterRejection);
  return [...valid, ...rejected];
}

function weightFor(riskTolerance: string): { cost: number; speed: number; risk: number } {
  switch (riskTolerance) {
    case "MAX_RELIABILITY":
      return { cost: 0.2, speed: 0.2, risk: 0.6 };
    case "BALANCED":
      return { cost: 0.4, speed: 0.25, risk: 0.35 };
    case "LOWEST_COST":
      return { cost: 0.65, speed: 0.2, risk: 0.15 };
    default:
      return { cost: 0.4, speed: 0.25, risk: 0.35 };
  }
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

  // Rank and tag
  return rankAndTag(filtered, input.riskTolerance);
}

// Quick helper used by the engine ticker to check whether a *better* route
// than the current reference exists. "Better" = strictly higher score under
// the user's risk tolerance, OR same score but cheaper.
export function isBetterRoute(newRoute: CandidateRoute, refRoute: CandidateRoute, riskTolerance: string): boolean {
  if (newRoute.hardFilterRejection) return false;
  if (refRoute.hardFilterRejection) return true;
  const w = weightFor(riskTolerance);
  const score = (r: CandidateRoute) =>
    r.risk.composite * w.risk + (r.effectiveCost.toNumber() / (r.legs[0]?.amount.toNumber() || 1)) * w.cost + (r.expectedExecutionSeconds / 600) * w.speed;
  return score(newRoute) < score(refRoute);
}
