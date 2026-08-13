// Shared Pure Economics — dependency-free functions used by BOTH the
// production engine AND the simulator.
//
// ARCHITECTURE RULE: these functions contain NO database imports, NO Prisma,
// NO side effects. They are pure calculations that take plain data and return
// plain results. Production wraps them with DB data; simulation wraps them
// with SimWorld data.
//
// This prevents the simulator from becoming a "second economic engine."

// ---- Risk Tolerance Weights ----
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

// ---- Settlement Asset Risk ----
export interface SettlementAssetRiskInput {
  assetType: string;
  volatilityScore: number;
  liquidityScore: number;
  pegQuality: number | null;
  status: string;
  incentiveRate: number;
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

// ---- Asset Risk Ceilings ----
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

// ---- Hard Collateral Invariant ----
export function isCollateralEligible(
  assetType: string,
  isEligibleCollateral: boolean,
  status: string,
): boolean {
  if (assetType === "VOLATILE_TOKEN") return false;
  if (status !== "ACTIVE") return false;
  return isEligibleCollateral;
}

// ---- Route Scoring (Absolute Quality — stable across time) ----
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
}

export interface RouteInfo {
  legs: RouteLegInfo[];
  effectiveCost: number;
  expectedExecutionSeconds: number;
  riskComposite: number;
}

export interface RouteScoreContext {
  riskTolerance: string;
  reputationMap?: Map<string, number>;
  corridorScores?: Map<string, number>;
  commitmentReliability?: Map<string, number>;
}

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

export function shouldReplaceRoute(
  newRoute: RouteInfo,
  refRoute: RouteInfo,
  ctx: RouteScoreContext,
): { replace: boolean; improvement: number; reason: string } {
  const refQuality = calculateAbsoluteRouteQuality(refRoute, ctx);
  const newQuality = calculateAbsoluteRouteQuality(newRoute, ctx);
  const improvement = refQuality - newQuality;

  if (improvement >= ROUTE_REPLACEMENT_THRESHOLD) {
    return { replace: true, improvement, reason: `absolute quality improved by ${improvement.toFixed(4)}` };
  }
  return { replace: false, improvement, reason: `improvement ${improvement.toFixed(4)} below threshold` };
}

// ---- Provider Reputation Components ----
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
  // Weighted values (already recency+value weighted by caller)
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

// ---- Provider Economics ----
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
    ? (netEarnings / input.averageDeployedCapital) * input.stepsPerYear // annualized
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

// ---- Equilibrium Detection ----
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
  stableReturns: boolean;     // returns stable over recent window
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

// ---- Helpers ----
function clamp01(n: number): number {
  if (!isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
