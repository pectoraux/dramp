// ============================================================================
// Canonical Pure Economics — the SINGLE source of truth for every economic
// calculation in dRamp.
//
// ARCHITECTURE RULES:
//   1. NO database imports. NO Prisma. NO side effects. NO Decimal.
//   2. All functions are pure: plain data in → plain data out.
//   3. Production wraps them with DB data; simulation wraps them with SimWorld
//      data. Both call the EXACT SAME functions.
//   4. If a formula exists here, it MUST NOT be duplicated in routing.ts,
//      risk.ts, reputation.ts, provider-economics.ts, or engine-faithful.ts.
//      Those modules import from here.
//
// This prevents economic drift between production and simulation.
// ============================================================================

// ---------------------------------------------------------------------------
// Section 1 — Risk Tolerance Weights
// ---------------------------------------------------------------------------

export interface RiskWeights {
  cost: number;
  speed: number;
  risk: number;
  reputation: number;
}

export function weightFor(riskTolerance: string): RiskWeights {
  switch (riskTolerance) {
    case "MAX_RELIABILITY":
      return { cost: 0.15, speed: 0.15, risk: 0.55, reputation: 0.15 };
    case "BALANCED":
      return { cost: 0.35, speed: 0.20, risk: 0.30, reputation: 0.15 };
    case "LOWEST_COST":
      return { cost: 0.60, speed: 0.15, risk: 0.10, reputation: 0.15 };
    default:
      return { cost: 0.35, speed: 0.20, risk: 0.30, reputation: 0.15 };
  }
}

// ---------------------------------------------------------------------------
// Section 2 — Provider Counterparty Risk (0..1, higher = riskier)
// ---------------------------------------------------------------------------

// Trust-model baseline risk (matches engine/types.ts TRUST_MODEL).
const TRUST_MODEL_BASE_RISK: Record<string, number> = {
  COLLATERALIZED: 0.15,
  INSTITUTIONALLY_TRUSTED: 0.10,
  PRE_FUNDED: 0.25,
  EXTERNAL_ESCROW: 0.30,
  NON_CUSTODIAL: 0.40,
};

// Provider-type risk adjustment (matches engine/types.ts PROVIDER_TYPE).
const PROVIDER_TYPE_RISK_ADJUST: Record<string, number> = {
  BANK: -0.05,
  PSP: -0.02,
  CEX: 0.03,
  DEX: 0.08,
  STABLECOIN_LP: 0.02,
  LOCAL_FIAT_AGENT: 0.05,
  MARKET_MAKER: 0.04,
  TREASURY: -0.08,
  SETTLEMENT_ASSET_SPONSOR: 0.06,
  HYBRID: 0.0,
};

export interface ProviderRiskInfo {
  trustModel: string;
  providerType: string;
  reputationScore: number; // 0..1 (1 = best)
  status: string;
  failureRate?: number; // 0..1
  disputeRate?: number; // 0..1
  operatingMonths?: number;
}

export function providerCounterpartyRisk(input: ProviderRiskInfo): number {
  if (input.status !== "ACTIVE") return 1.0;
  let risk = TRUST_MODEL_BASE_RISK[input.trustModel] ?? 0.4;
  risk += PROVIDER_TYPE_RISK_ADJUST[input.providerType] ?? 0;
  risk += (1 - (input.reputationScore ?? 0.5)) * 0.2;
  risk += (input.failureRate ?? 0) * 0.3;
  risk += (input.disputeRate ?? 0) * 0.2;
  const months = input.operatingMonths ?? 0;
  if (months > 0) risk -= Math.min(0.1, months / 1200);
  return clamp01(risk);
}

// ---------------------------------------------------------------------------
// Section 3 — Settlement Asset Risk (0..1)
// ---------------------------------------------------------------------------

export interface SettlementAssetRiskInput {
  assetType: string;
  volatilityScore: number; // 0..1
  liquidityScore: number; // 0..1
  pegQuality: number | null; // 0..1 (stablecoins only)
  status: string;
  incentiveRate: number; // bps
}

export function settlementAssetRisk(input: SettlementAssetRiskInput): number {
  if (input.status !== "ACTIVE") return 1.0;
  let risk = 0;
  if (input.assetType === "VOLATILE_TOKEN") risk += 0.35;
  risk += input.volatilityScore * 0.3;
  risk += (1 - input.liquidityScore) * 0.2;
  if (input.assetType === "STABLECOIN") {
    const peg = input.pegQuality ?? 0.8;
    risk += (1 - peg) * 0.2;
  }
  if (input.incentiveRate > 40) risk += 0.1;
  if (input.incentiveRate > 80) risk += 0.1;
  return clamp01(risk);
}

// ---------------------------------------------------------------------------
// Section 4 — Route Risk Dimensions (5 separate dimensions + composite)
// ---------------------------------------------------------------------------

export interface RouteLegRiskInfo {
  provider: ProviderRiskInfo;
  channelType: string; // AUTOMATIC | MANUAL
  offerCapacity: number;
  legAmount: number;
  settlementAsset?: SettlementAssetRiskInput;
  expectedExecutionSeconds: number;
}

export interface RouteRiskResult {
  counterparty: number;
  settlementAsset: number;
  liquidity: number;
  operational: number;
  duration: number;
  composite: number;
}

export function computeRouteRisk(legs: RouteLegRiskInfo[]): RouteRiskResult {
  if (legs.length === 0) {
    return { counterparty: 1, settlementAsset: 1, liquidity: 1, operational: 1, duration: 1, composite: 1 };
  }
  const counterparty = Math.max(...legs.map((l) => providerCounterpartyRisk(l.provider)));
  const settlementLegs = legs.filter((l) => l.settlementAsset);
  const settlementAsset = settlementLegs.length
    ? Math.max(...settlementLegs.map((l) => settlementAssetRisk(l.settlementAsset!)))
    : 0.1;
  const liquidity = Math.max(
    ...legs.map((l) => {
      const cap = l.offerCapacity;
      const amt = l.legAmount;
      if (cap <= 0) return 1;
      const util = amt / cap;
      if (util <= 0.3) return 0.1;
      if (util <= 0.5) return 0.25;
      if (util <= 0.7) return 0.45;
      if (util <= 0.9) return 0.7;
      return 0.95;
    }),
  );
  const manualLegs = legs.filter((l) => l.channelType === "MANUAL").length;
  const operational = clamp01(0.1 + manualLegs * 0.2 + (legs.length - 1) * 0.05);
  const totalSeconds = legs.reduce((s, l) => s + l.expectedExecutionSeconds, 0);
  const duration = clamp01(totalSeconds / 600);
  const composite = clamp01(
    counterparty * 0.3 + settlementAsset * 0.2 + liquidity * 0.2 + operational * 0.15 + duration * 0.15,
  );
  return { counterparty, settlementAsset, liquidity, operational, duration, composite };
}

// ---------------------------------------------------------------------------
// Section 5 — Risk Ceilings
// ---------------------------------------------------------------------------

export function assetRiskCeiling(riskTolerance: string): number {
  switch (riskTolerance) {
    case "MAX_RELIABILITY": return 0.25;
    case "BALANCED": return 0.50;
    case "LOWEST_COST": return 0.80;
    default: return 0.50;
  }
}

export function counterpartyRiskCeiling(riskTolerance: string): number {
  switch (riskTolerance) {
    case "MAX_RELIABILITY": return 0.30;
    case "BALANCED": return 0.55;
    case "LOWEST_COST": return 0.80;
    default: return 0.55;
  }
}

// ---------------------------------------------------------------------------
// Section 6 — Hard Collateral Invariant
// ---------------------------------------------------------------------------

export function isCollateralEligible(
  assetType: string,
  isEligibleCollateral: boolean,
  status: string,
): boolean {
  if (assetType === "VOLATILE_TOKEN") return false;
  if (status !== "ACTIVE") return false;
  return isEligibleCollateral;
}

// ---------------------------------------------------------------------------
// Section 7 — Route Data Types (plain-number, shared by production + sim)
// ---------------------------------------------------------------------------

export const ABS_COST_REF = 0.01;   // 1% = penalty 1.0
export const ABS_DURATION_REF = 600; // 10 min = penalty 1.0
export const ROUTE_REPLACEMENT_THRESHOLD = 0.01;

export interface RouteLegInfo {
  providerId: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  role: string; // SOURCE | SETTLEMENT_HOP | DESTINATION
  amount: number;
  feeBps: number;
  channelType: string;
  offerCapacity: number;
  expectedExecutionSeconds: number;
  settlementAssetId?: string | null;
  // Risk inputs for the leg's provider + settlement asset.
  provider: ProviderRiskInfo;
  settlementAsset?: SettlementAssetRiskInput;
}

export interface RouteInfo {
  legs: RouteLegInfo[];
  effectiveCost: number;
  expectedExecutionSeconds: number;
  riskComposite: number;
  // Optional: pre-computed risk breakdown (if caller already has it).
  risk?: RouteRiskResult;
}

export interface RouteScoreContext {
  riskTolerance: string;
  reputationMap?: Map<string, number>;
  corridorScores?: Map<string, number>;
  commitmentReliability?: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Section 8 — Route Reputation & Commitment Aggregation
// ---------------------------------------------------------------------------

export function computeRouteReputation(route: RouteInfo, ctx: RouteScoreContext): number {
  if (route.legs.length === 0) return 0.5;
  const legScores = route.legs.map((l) => {
    const corridorKey = `${l.providerId}:${l.sourceAsset}:${l.destinationAsset}:${l.sourceCountry}:${l.destinationCountry}`;
    const corridorScore = ctx.corridorScores?.get(corridorKey);
    if (corridorScore !== undefined) return corridorScore;
    return ctx.reputationMap?.get(l.providerId) ?? 0.5;
  });
  const avg = legScores.reduce((s, x) => s + x, 0) / legScores.length;
  const minScore = Math.min(...legScores);
  return avg * 0.7 + minScore * 0.3;
}

export function computeRouteCommitment(route: RouteInfo, ctx: RouteScoreContext): number {
  if (route.legs.length === 0) return 0;
  const legCommitments = route.legs.map((l) => {
    return ctx.commitmentReliability?.get(l.providerId) ?? 0;
  });
  return legCommitments.reduce((s, x) => s + x, 0) / legCommitments.length;
}

// ---------------------------------------------------------------------------
// Section 9 — Absolute Route Quality (stable across time, for WAIT_FOR_BETTER)
// ---------------------------------------------------------------------------

export function calculateAbsoluteRouteQuality(route: RouteInfo, ctx: RouteScoreContext): number {
  const w = weightFor(ctx.riskTolerance);
  const sourceNotional = route.legs
    .filter((l) => l.role === "SOURCE")
    .reduce((s, l) => s + l.amount, 0);
  const notional = sourceNotional || route.legs[0]?.amount || 1;

  const absCost = Math.min(1, route.effectiveCost / notional / ABS_COST_REF);
  const absDur = Math.min(1, route.expectedExecutionSeconds / ABS_DURATION_REF);
  const absRisk = Math.min(1, route.riskComposite);

  const routeRep = computeRouteReputation(route, ctx);
  const absRep = 1 - routeRep;

  const routeCommit = computeRouteCommitment(route, ctx);
  const commitReduction = routeCommit * 0.2;

  const adjustedRepPenalty = w.reputation * absRep * (1 - commitReduction);
  return w.cost * absCost + w.speed * absDur + w.risk * absRisk + adjustedRepPenalty;
}

// ---------------------------------------------------------------------------
// Section 10 — Route Replacement (cross-time, uses absolute quality)
// ---------------------------------------------------------------------------

export function shouldReplaceRoute(
  newRoute: RouteInfo,
  refRoute: RouteInfo,
  ctx: RouteScoreContext,
): { replace: boolean; improvement: number; reason: string } {
  const refQuality = calculateAbsoluteRouteQuality(refRoute, ctx);
  const newQuality = calculateAbsoluteRouteQuality(newRoute, ctx);
  const improvement = refQuality - newQuality; // positive = new is better

  if (improvement >= ROUTE_REPLACEMENT_THRESHOLD) {
    return { replace: true, improvement, reason: `absolute quality improved by ${improvement.toFixed(4)} (threshold: ${ROUTE_REPLACEMENT_THRESHOLD})` };
  }
  return { replace: false, improvement, reason: `improvement ${improvement.toFixed(4)} below threshold ${ROUTE_REPLACEMENT_THRESHOLD}` };
}

// ---------------------------------------------------------------------------
// Section 11 — Candidate-Set-Relative Route Ranking (initial selection)
//
// This is the marketplace ranking algorithm. It normalizes each dimension
// (cost, speed, risk, reputation) across the CURRENT candidate set, then
// computes a weighted penalty using the user's risk tolerance weights.
//
// Used by BOTH production rankAndTag AND simulator matchAndExecute for
// initial route selection. This is NOT the same as calculateAbsoluteRouteQuality
// (which is for cross-time comparison in WAIT_FOR_BETTER).
// ---------------------------------------------------------------------------

export type RouteTag = "BEST" | "CHEAPEST" | "FASTEST" | "SAFEST" | "CANDIDATE";

export interface RankedRoute {
  route: RouteInfo;
  score: number;     // higher = better (1 - weighted penalty)
  tag: RouteTag;
}

export function rankRoutes(
  routes: RouteInfo[],
  ctx: RouteScoreContext,
): RankedRoute[] {
  if (routes.length === 0) return [];

  const weights = weightFor(ctx.riskTolerance);

  // Identify extremes for tagging.
  let cheapest = routes[0];
  let fastest = routes[0];
  let safest = routes[0];
  for (const r of routes) {
    if (r.effectiveCost < cheapest.effectiveCost) cheapest = r;
    if (r.expectedExecutionSeconds < fastest.expectedExecutionSeconds) fastest = r;
    if (r.riskComposite < safest.riskComposite) safest = r;
  }

  // Reputation per route (using shared aggregation).
  const repScores = routes.map((r) => computeRouteReputation(r, ctx));
  const repMax = Math.max(...repScores, 0.5);
  const repMin = Math.min(...repScores, 0.5);

  // Commitment boost per route.
  const commitBoost = routes.map((r) => computeRouteCommitment(r, ctx));

  // Normalization bounds across the candidate set.
  const costMax = Math.max(...routes.map((r) => r.effectiveCost)) || 1;
  const costMin = cheapest.effectiveCost;
  const durMax = Math.max(...routes.map((r) => r.expectedExecutionSeconds)) || 1;
  const durMin = fastest.expectedExecutionSeconds;
  const riskMax = Math.max(...routes.map((r) => r.riskComposite)) || 1;
  const riskMin = safest.riskComposite;

  const scored: RankedRoute[] = routes.map((r, idx) => {
    const normCost = costMax === costMin ? 0 : (r.effectiveCost - costMin) / (costMax - costMin);
    const normDur = durMax === durMin ? 0 : (r.expectedExecutionSeconds - durMin) / (durMax - durMin);
    const normRisk = riskMax === riskMin ? 0 : (r.riskComposite - riskMin) / (riskMax - riskMin);
    const normRep = repMax === repMin ? 0 : (repMax - repScores[idx]) / (repMax - repMin);
    const commitReduction = commitBoost[idx] * 0.2;
    const adjustedRepPenalty = weights.reputation * normRep * (1 - commitReduction);
    const penalty = weights.cost * normCost + weights.speed * normDur + weights.risk * normRisk + adjustedRepPenalty;
    return { route: r, score: 1 - penalty, tag: "CANDIDATE" as RouteTag };
  });

  // Assign BEST to the highest-scoring route.
  scored.sort((a, b) => b.score - a.score);
  scored[0].tag = "BEST";

  // Assign CHEAPEST / FASTEST / SAFEST (may overlap with BEST).
  for (const sr of scored) {
    if (sr.route === cheapest && sr.tag === "CANDIDATE") sr.tag = "CHEAPEST";
    else if (sr.route === fastest && sr.tag === "CANDIDATE") sr.tag = "FASTEST";
    else if (sr.route === safest && sr.tag === "CANDIDATE") sr.tag = "SAFEST";
  }

  // Order: BEST first, then CHEAPEST, FASTEST, SAFEST, then others by score.
  const tagOrder: Record<RouteTag, number> = {
    BEST: 0, CHEAPEST: 1, FASTEST: 2, SAFEST: 3, CANDIDATE: 4,
  };
  scored.sort((a, b) => (tagOrder[a.tag] ?? 9) - (tagOrder[b.tag] ?? 9));
  return scored;
}

// ---------------------------------------------------------------------------
// Section 12 — Hard Filters (route eligibility predicates)
//
// A route that violates a hard filter is INVALID. Hard filters NEVER optimize.
// ---------------------------------------------------------------------------

export interface HardFilterContext {
  riskTolerance: string;
  prohibitedSettlementAssets: string[]; // asset ids
  allowedSettlementAssets: string[]; // asset ids (empty = all eligible)
}

export interface HardFilterResult {
  rejectionReason: string | null;
}

export function applyHardFilters(route: RouteInfo, ctx: HardFilterContext): HardFilterResult {
  for (const leg of route.legs) {
    // Provider suspension.
    if (leg.provider.status !== "ACTIVE") {
      return { rejectionReason: "Provider suspended" };
    }
    // Prohibited settlement asset.
    if (leg.settlementAssetId && ctx.prohibitedSettlementAssets.includes(leg.settlementAssetId)) {
      return { rejectionReason: "Uses a prohibited settlement asset" };
    }
    // Allowed settlement asset whitelist.
    if (
      leg.settlementAssetId &&
      ctx.allowedSettlementAssets.length > 0 &&
      !ctx.allowedSettlementAssets.includes(leg.settlementAssetId)
    ) {
      return { rejectionReason: "Settlement asset not in allow-list" };
    }
    // Settlement-asset risk ceiling.
    if (leg.settlementAsset) {
      const ceiling = assetRiskCeiling(ctx.riskTolerance);
      const r = settlementAssetRisk(leg.settlementAsset);
      if (r > ceiling) {
        return { rejectionReason: `Settlement-asset risk ${r.toFixed(2)} exceeds ceiling ${ceiling.toFixed(2)} for ${ctx.riskTolerance}` };
      }
    }
    // Counterparty risk ceiling.
    const cpr = providerCounterpartyRisk(leg.provider);
    if (cpr > counterpartyRiskCeiling(ctx.riskTolerance)) {
      return { rejectionReason: `Counterparty risk ${cpr.toFixed(2)} exceeds ceiling for ${ctx.riskTolerance}` };
    }
    // Capacity: leg amount must not exceed offer capacity.
    if (leg.offerCapacity > 0 && leg.amount / leg.offerCapacity > 1) {
      return { rejectionReason: "Insufficient capacity" };
    }
  }
  return { rejectionReason: null };
}

// ---------------------------------------------------------------------------
// Section 13 — Reputation (7 explainable components, anti-gaming)
// ---------------------------------------------------------------------------

export const MEANINGFUL_THRESHOLD = 50;   // $50 minimum for reputation
export const VALUE_BASE = 100;             // $100 = weight 1.0
const DAY_MS = 86400000;

export function decayWeight(ageMs: number): number {
  const days = ageMs / DAY_MS;
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.5;
  if (days <= 90) return 0.25;
  return 0.1;
}

// Value weighting: sqrt(volume / base), capped at 3.0 to prevent dominance.
export function valueWeight(volume: number): number {
  if (volume < MEANINGFUL_THRESHOLD) return 0;
  return Math.min(3.0, Math.sqrt(volume / VALUE_BASE));
}

export interface ReputationComponents {
  reliability: number;    // 0..100
  speed: number;          // 0..100
  liquidityQuality: number; // 0..100
  pricing: number;        // 0..100
  disputes: number;       // 0..100
  operational: number;    // 0..100
  history: number;        // 0..100
  overall: number;        // 0..100
  sampleSize: number;
  decayNote: string;
}

export interface ReputationInput {
  completed: number;
  failed: number;
  cancelled: number;
  disputes: number;
  slashes: number;
  avgDurationSeconds: number;
  utilization: number; // 0..1
  medianFeeBps: number;
  networkMedianFeeBps: number;
  ageDays: number;
  // Weighted values (already recency+value weighted by caller).
  weightedCompleted: number;
  weightedFailed: number;
  weightedCancelled: number;
  weightedDisputes: number;
  weightedSlashes: number;
  meaningfulExecutions: number;
}

export function calculateReputation(input: ReputationInput): ReputationComponents {
  const totalExecs = input.weightedCompleted + input.weightedFailed + input.weightedCancelled;
  const reliability = totalExecs > 0 ? (input.weightedCompleted / totalExecs) * 100 : 50;
  const speed = Math.max(0, Math.min(100, 100 - (input.avgDurationSeconds / 600) * 100));
  const liquidityQuality = Math.min(100, 100 - input.utilization * 100);
  const pricing = input.networkMedianFeeBps > 0
    ? Math.max(0, Math.min(100, 100 - ((input.medianFeeBps - input.networkMedianFeeBps) / input.networkMedianFeeBps) * 50))
    : 50;
  const disputeRate = totalExecs > 0 ? input.weightedDisputes / totalExecs : 0;
  const disputes = Math.max(0, 100 - disputeRate * 200);
  const operationalRate = totalExecs > 0 ? input.weightedFailed / totalExecs : 0;
  const operational = Math.max(0, 100 - operationalRate * 150);
  const history = Math.min(100, (input.ageDays / 90) * 100);

  const overall = Math.round(
    reliability * 0.25 + speed * 0.15 + liquidityQuality * 0.15 +
    pricing * 0.15 + disputes * 0.15 + operational * 0.10 + history * 0.05
  );

  return {
    reliability: Math.round(reliability),
    speed: Math.round(speed),
    liquidityQuality: Math.round(liquidityQuality),
    pricing: Math.round(pricing),
    disputes: Math.round(disputes),
    operational: Math.round(operational),
    history: Math.round(history),
    overall,
    sampleSize: input.meaningfulExecutions,
    decayNote: "Anti-gaming: only transactions ≥ $50 count. Weighted by sqrt(value/$100) × recency.",
  };
}

export function deriveTier(reputation: number, meaningfulExecs: number, ageDays: number, slashes: number): string {
  if (slashes > 0) return "VERIFIED";
  if (reputation >= 85 && meaningfulExecs >= 10 && ageDays >= 30) return "PREMIUM";
  if (reputation >= 70 && meaningfulExecs >= 5 && ageDays >= 14) return "TRUSTED";
  if (meaningfulExecs >= 1 || ageDays >= 7) return "VERIFIED";
  return "NEW";
}

// ---------------------------------------------------------------------------
// Section 14 — Provider Economics (full P&L with capital cost + expected loss)
// ---------------------------------------------------------------------------

export interface ProviderEconomicsInput {
  grossFees: number;
  incentives: number;
  rebates: number;
  settlementCosts: number;
  operatingCosts: number;
  capitalCostRate: number; // annualized, e.g. 0.05 = 5%
  averageDeployedCapital: number;
  expectedLossRate: number; // e.g. 0.001 = 10bps
  penalties: number;
  slashing: number;
  stepsPerYear: number;
}

export interface ProviderEconomicsResult {
  grossEarnings: number;
  totalCosts: number;
  netEarnings: number;
  capitalCost: number;
  expectedLoss: number;
  riskAdjustedReturn: number; // netEarnings / averageDeployedCapital (annualized)
}

export function calculateProviderEconomics(input: ProviderEconomicsInput): ProviderEconomicsResult {
  const grossEarnings = input.grossFees + input.incentives + input.rebates;
  const capitalCost = input.averageDeployedCapital * input.capitalCostRate * (1 / input.stepsPerYear);
  const expectedLoss = input.averageDeployedCapital * input.expectedLossRate * (1 / input.stepsPerYear);
  const totalCosts = input.settlementCosts + input.operatingCosts + capitalCost + expectedLoss + input.penalties + input.slashing;
  const netEarnings = grossEarnings - totalCosts;
  const riskAdjustedReturn = input.averageDeployedCapital > 0
    ? (netEarnings / input.averageDeployedCapital) * input.stepsPerYear
    : 0;

  return {
    grossEarnings: round(grossEarnings),
    totalCosts: round(totalCosts),
    netEarnings: round(netEarnings),
    capitalCost: round(capitalCost),
    expectedLoss: round(expectedLoss),
    riskAdjustedReturn: round(riskAdjustedReturn),
  };
}

// ---------------------------------------------------------------------------
// Section 15 — Equilibrium Detection (economic thresholds)
// ---------------------------------------------------------------------------

export interface EquilibriumInput {
  medianRiskAdjustedReturn: number;
  providerEntryRate: number;  // per step
  providerExitRate: number;   // per step
  routeCoverage: number;      // 0..1
  avgCostBps: number;
  baselineCostBps: number;
  marketConcentration: number; // HHI 0..1
  incentiveDependent: boolean;
  recentSteps: number;
  stableReturns: boolean;
}

export function detectEquilibrium(input: EquilibriumInput): {
  status: string;
  reasons: string[];
} {
  const reasons: string[] = [];

  const positiveReturns = input.medianRiskAdjustedReturn > 0;
  const sufficientCoverage = input.routeCoverage >= 0.7;
  const competitive = input.avgCostBps < input.baselineCostBps * 0.8;
  const notConcentrated = input.marketConcentration < 0.5;
  const entryExitsBalanced = input.providerEntryRate >= input.providerExitRate * 0.5;

  if (positiveReturns) reasons.push(`positive risk-adjusted return (${(input.medianRiskAdjustedReturn * 100).toFixed(2)}%)`);
  if (sufficientCoverage) reasons.push(`sufficient route coverage (${(input.routeCoverage * 100).toFixed(0)}%)`);
  if (competitive) reasons.push(`competitive user cost (${input.avgCostBps.toFixed(0)} bps vs ${input.baselineCostBps} baseline)`);
  if (notConcentrated) reasons.push(`low concentration (HHI ${input.marketConcentration.toFixed(2)})`);
  if (input.incentiveDependent) reasons.push(`dependent on active incentives`);

  if (input.recentSteps < 20) {
    return { status: "FORMING", reasons: ["insufficient history"] };
  }

  if (!positiveReturns || !sufficientCoverage) {
    return { status: "NEGATIVE", reasons: reasons.length > 0 ? reasons : ["negative returns or insufficient coverage"] };
  }

  if (input.incentiveDependent || !notConcentrated || !entryExitsBalanced) {
    return { status: "FRAGILE", reasons };
  }

  if (!input.stableReturns) {
    return { status: "FRAGILE", reasons: [...reasons, "returns not yet stable"] };
  }

  return { status: "POSITIVE", reasons };
}

// ---------------------------------------------------------------------------
// Section 16 — Helpers
// ---------------------------------------------------------------------------

export function clamp01(n: number): number {
  if (!isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Section 17 — Hop Economics (fee + FX rate + incentive)
//
// The CANONICAL hop-output formula. Production (routing.ts) and the topology
// experiment both call THIS function — no duplicate formula anywhere.
//
// Formula (mirrors production's Decimal implementation exactly):
//   fee        = inputAmount * feeBps / 10000
//   afterFee   = inputAmount - fee
//   converted  = afterFee * rate               // FX conversion
//   incentive  = converted * incentiveBps / 10000   // rebate (subsidized)
//   output     = converted + incentive          // net destination-asset amount
//
// Pure-number: production converts Decimal <-> number at the boundary. For
// monetary magnitudes in dRamp (<= ~$1M) float64 gives ~1e-10 dollar
// precision — far below the cent and below MONETARY_EPSILON (0.01).
// ---------------------------------------------------------------------------

export interface HopEconomics {
  feeBps: number;
  rate: number;
  incentiveBps: number;
}

export interface HopOutputResult {
  output: number;    // net destination-asset amount after fee, FX, incentive
  fee: number;       // fee portion (source-asset terms)
  incentive: number; // incentive rebate (destination-asset terms)
}

export function computeHopOutput(inputAmount: number, econ: HopEconomics): HopOutputResult {
  const fee = (inputAmount * econ.feeBps) / 10000;
  const afterFee = inputAmount - fee;
  const converted = afterFee * econ.rate;
  const incentive = (converted * econ.incentiveBps) / 10000;
  const output = converted + incentive;
  return { output, fee, incentive };
}

// ---------------------------------------------------------------------------
// Section 18 — Split-Capacity Cover (coverAmount)
//
// Assigns an input amount across parallel offers for a single hop. Tries a
// single offer first; if none can cover the full amount, splits across
// multiple offers. Returns null if combined capacity is insufficient.
//
// This is the CANONICAL split-routing logic. Production (routing.ts) and the
// topology experiment both call THIS function.
//
// Sort order (mirrors production): AUTOMATIC channel first, then lower fee,
// then higher available capacity. Split pieces must each satisfy minimumAmount.
// ---------------------------------------------------------------------------

export interface CoverOffer {
  id: string;
  channelType: string;        // AUTOMATIC | MANUAL
  feeBps: number;
  availableCapacity: number;
  reservedCapacity: number;
  minimumAmount: number;
}

export interface CoverAssignment {
  offerId: string;
  amount: number;             // input amount assigned to this offer
}

export interface CoverResult {
  assignments: CoverAssignment[];
  split: boolean;             // true if more than one offer was used
}

export function coverAmount(offers: CoverOffer[], amount: number): CoverResult | null {
  // Filter to offers with positive available capacity, then sort by preference.
  const usable = offers
    .filter((o) => o.availableCapacity > 0)
    .sort((a, b) => {
      // Prefer AUTOMATIC channel.
      if (a.channelType !== b.channelType) {
        return a.channelType === "AUTOMATIC" ? -1 : 1;
      }
      // Then lower fee.
      if (a.feeBps !== b.feeBps) return a.feeBps - b.feeBps;
      // Then higher available capacity.
      return b.availableCapacity - a.availableCapacity;
    });

  // Try a single offer first.
  for (const o of usable) {
    const avail = o.availableCapacity - o.reservedCapacity;
    if (avail >= amount && amount >= o.minimumAmount) {
      return { assignments: [{ offerId: o.id, amount }], split: false };
    }
  }

  // Otherwise split across multiple offers greedily.
  const assignments: CoverAssignment[] = [];
  let remaining = amount;
  for (const o of usable) {
    if (remaining <= 0) break;
    const avail = o.availableCapacity - o.reservedCapacity;
    if (avail <= 0) continue;
    const take = Math.min(remaining, avail);
    if (take < o.minimumAmount) continue;
    assignments.push({ offerId: o.id, amount: take });
    remaining -= take;
  }
  if (remaining > 0) return null; // insufficient combined capacity
  return { assignments, split: assignments.length > 1 };
}

// ---------------------------------------------------------------------------
// Section 19 — Path Enumeration (simple paths up to maxHops)
//
// DFS simple-path enumeration on a generic adjacency map. Production
// (routing.ts) and the topology experiment both call THIS function.
//
// Generic over edge type E so production can pass its Decimal-laden AdjEdge
// and the experiment can pass its plain SimOffer. The DFS logic itself is
// identical — no duplicate path-search code.
//
// Behavior preserved exactly from production's prior implementation, including
// the parallel-edge grouping (all offers between the same node pair are
// collected into one PathStep.edges array for split-capacity routing).
// ---------------------------------------------------------------------------

export interface AdjacencyEdge<E> {
  to: string;
  edge: E;
}

export interface PathStep<E> {
  fromNode: string;
  toNode: string;
  edges: E[]; // parallel offers serving this hop (all go fromNode -> toNode)
}

export function enumeratePaths<E>(
  adj: Map<string, AdjacencyEdge<E>[]>,
  source: string,
  dest: string,
  maxHops: number,
): PathStep<E>[][] {
  const results: PathStep<E>[][] = [];
  const visited = new Set<string>([source]);

  function dfs(current: string, path: PathStep<E>[]) {
    if (path.length > 0 && current === dest) {
      results.push([...path]);
      return;
    }
    if (path.length >= maxHops) return;
    const edges = adj.get(current) ?? [];
    for (const e of edges) {
      if (visited.has(e.to)) continue;
      // Don't allow trivial self-loops.
      visited.add(e.to);
      // Group parallel edges: all edges from `current` to `e.to`.
      const parallel = edges.filter((x) => x.to === e.to).map((p) => p.edge);
      path.push({ fromNode: current, toNode: e.to, edges: parallel });
      dfs(e.to, path);
      path.pop();
      visited.delete(e.to);
    }
  }
  dfs(source, []);
  return results;
}
