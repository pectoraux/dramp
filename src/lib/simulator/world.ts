// dRamp Network Simulator — World State
//
// In-memory simulation world. Does NOT touch the production database.
// All simulated entities are plain objects — no Prisma, no ledger mutations.

import { Decimal } from "@/lib/engine/money";

export interface SimSettlementAsset {
  id: string;
  symbol: string;
  assetType: string; // STABLECOIN | VOLATILE_TOKEN | INTERNAL_SETTLEMENT_UNIT
  volatilityScore: number;
  liquidityScore: number;
  pegQuality: number | null;
  incentiveRate: number; // bps
  collateralHaircut: number;
  isEligibleCollateral: boolean;
  status: string;
}

export interface SimProvider {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  reputationScore: number;
  tier: string;
  status: string; // ACTIVE | EXITED | SUSPENDED
  exitReason: string | null; // ECONOMIC_EXIT | RISK_SUSPENSION | OPERATIONAL_SUSPENSION | null
  strategy: string; // AGGRESSIVE | PREMIUM | LIQUIDITY_MAXIMIZER | MARKET_MAKER | INCENTIVE_SEEKER | CONSERVATIVE | OPPORTUNISTIC
  collateral: number;
  usableCollateral: number;
  lockedCollateral: number;
  maxExposure: number;
  corridors: string[]; // ["USD:US:EUR:EU", ...]
  // Tracked economics (aggregate totals)
  totalVolume: number;
  totalEarnings: number;
  totalIncentives: number;
  totalPenalties: number;
  totalSlashing: number;
  executionsCompleted: number;
  executionsFailed: number;
  utilization: number; // reserved / available (computed from actual reservations)
  entryStep: number;
  exitStep: number | null;
  // Deployed capital tracking: sum of (amount × duration) across all executions.
  // Used for time-consistent capital cost calculation.
  totalDeployedCapitalSteps: number; // Σ (amount × steps_deployed) — capital-time product
  currentDeployedCapital: number; // currently reserved/deployed capital
  // Per-execution history for faithful reputation recalculation.
  // Each record captures the amount, outcome, duration, and sim-time so the
  // shared calculateReputation function can apply recency + value weighting.
  executionHistory: SimExecutionRecord[];
}

export interface SimOffer {
  id: string;
  providerId: string;
  capability: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  rate: number;
  feeBps: number;
  minimumAmount: number;
  maximumAmount: number;
  availableCapacity: number;
  reservedCapacity: number;
  settlementAssetId: string | null;
  channelType: string;
  expectedExecutionSeconds: number;
  incentiveBps: number;
  active: boolean;
  version: number;
}

export interface SimUser {
  id: string;
  name: string;
  sourceCountry: string;
  destinationCountry: string;
  sourceAsset: string;
  destinationAsset: string;
  typicalAmount: number;
  amountStdDev: number;
  frequency: number; // probability per step
  riskTolerance: string;
  executionPolicy: string; // NOW | WAIT_FOR_BETTER
  maxWaitSeconds: number;
  cancellationPolicy: string;
}

export interface SimIntent {
  id: string;
  userId: string;
  sourceAmount: number;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  riskTolerance: string;
  executionPolicy: string;
  maxWaitSeconds: number;
  status: string; // SEARCHING | EXECUTING | COMPLETED | FAILED | CANCELLED | EXPIRED
  createdAtStep: number;
  completedAtStep: number | null;
  selectedRouteId: string | null;
  routeTag: string | null;
  effectiveCost: number;
  netOutput: number;
  waitedSteps: number;
  failureReason: string | null;
}

export interface SimRoute {
  id: string;
  intentId: string;
  tag: string;
  legs: SimRouteLeg[];
  effectiveCost: number;
  netOutput: number;
  expectedExecutionSeconds: number;
  riskComposite: number;
  explanation: string;
}

export interface SimRouteLeg {
  providerId: string;
  providerName: string;
  sourceAsset: string;
  destinationAsset: string;
  feeBps: number;
  rate: number;
  channelType: string;
  amount: number;
}

// Per-execution record for faithful reputation recalculation.
// Mirrors what production stores in the Leg + Execution tables.
export interface SimExecutionRecord {
  providerId: string;
  amount: number;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED";
  durationSeconds: number;
  step: number;
  timeMs: number;
  feeBps: number;
  corridorKey: string; // providerId:srcAsset:dstAsset:srcCountry:dstCountry
}

export interface SimCampaign {
  id: string;
  settlementAssetId: string;
  name: string;
  incentiveBps: number;
  totalBudget: number;
  accrued: number;
  paid: number;
  status: string; // ACTIVE | EXHAUSTED | EXPIRED
  startStep: number;
  endStep: number;
}

export interface SimMetrics {
  // User outcomes
  totalIntents: number;
  completedIntents: number;
  failedIntents: number;
  cancelledIntents: number;
  expiredIntents: number;
  avgCostBps: number;
  avgWaitSteps: number;
  p50ExecutionSteps: number;
  p95ExecutionSteps: number;
  completionRate: number;
  // Provider outcomes
  activeProviders: number;
  exitedProviders: number;
  suspendedProviders: number; // RISK_SUSPENSION + OPERATIONAL_SUSPENSION
  economicExits: number;      // ECONOMIC_EXIT only
  avgProviderEarnings: number;       // simulation-period net earnings ($)
  medianProviderEarnings: number;    // simulation-period net earnings ($)
  avgUtilization: number;
  totalProviderVolume: number;
  totalProtocolRevenue: number;
  totalIncentiveSpend: number;
  // Provider economics (simulation-period, NOT annualized)
  medianNetProfit: number;           // $ net earnings (sim period)
  avgNetProfit: number;              // $ net earnings (sim period)
  medianNetMargin: number;           // % net margin (netEarnings / grossEarnings)
  medianProfitPerExecution: number;  // $ net earnings per execution
  medianAnnualizedReturnPct: number; // modeled extrapolation (labeled, not primary)
  // Network outcomes
  totalLiquidity: number;
  avgRoutesPerCorridor: number;
  corridorCoverage: number;
  marketConcentration: number; // HHI index
  // Equilibrium
  equilibriumStatus: string; // POSITIVE | FRAGILE | NEGATIVE | FORMING
}

export interface SimWorld {
  config: SimConfig;
  step: number;
  timeMs: number;
  assets: Map<string, SimSettlementAsset>;
  providers: Map<string, SimProvider>;
  offers: Map<string, SimOffer>;
  users: Map<string, SimUser>;
  intents: SimIntent[];
  routes: Map<string, SimRoute>;
  campaigns: Map<string, SimCampaign>;
  metricsHistory: SimMetrics[];
  // Running tallies
  totalVolume: number;
  totalFees: number;
  totalIncentives: number;
  totalPenalties: number;
  totalSlashing: number;
}

export interface SimConfig {
  seed: number;
  totalSteps: number;
  stepDurationMs: number;
  initialProviders: number;
  providerGrowthRate: number; // probability of new provider per step
  providerExitThreshold: number; // min earnings to stay
  demandVolume: number; // intents per step baseline
  demandGrowth: number; // demand growth per step
  riskDistribution: { maxReliability: number; balanced: number; lowestCost: number };
  policyDistribution: { now: number; waitForBetter: number };
  enableReputation: boolean;
  enableCommitments: boolean;
  enableIncentives: boolean;
  shockType: string | null; // LIQUIDITY | PROVIDER_EXIT | ASSET_DEPEG | INCENTIVE_END | DEMAND_SURGE | REGULATORY
  shockStep: number;
  shockMagnitude: number;
  baselineCostBps: number; // conventional remittance baseline for comparison
}

export function createDefaultConfig(): SimConfig {
  return {
    seed: 42,
    totalSteps: 100,
    stepDurationMs: 5000,
    initialProviders: 10,
    providerGrowthRate: 0.05,
    providerExitThreshold: 0.01,
    demandVolume: 5,
    demandGrowth: 0.001,
    riskDistribution: { maxReliability: 0.25, balanced: 0.60, lowestCost: 0.15 },
    policyDistribution: { now: 0.70, waitForBetter: 0.30 },
    enableReputation: true,
    enableCommitments: true,
    enableIncentives: true,
    shockType: null,
    shockStep: 50,
    shockMagnitude: 0.5,
    baselineCostBps: 300, // 3% baseline
  };
}

// Stable-network fixture: a deterministic configuration where at least 10
// providers remain active for 100+ steps. Used for controlled experiments
// where the network must NOT collapse.
//
// Key differences from default:
//   - 20 initial providers (enough for corridor coverage)
//   - 0% growth (no random entry)
//   - Lower exit threshold (providers stay longer)
//   - Higher demand (more volume → more revenue → providers survive)
//   - 100% NOW policy (no patient execution confounding)
export function createStableNetworkConfig(): SimConfig {
  return {
    seed: 42,
    totalSteps: 100,
    stepDurationMs: 5000,
    initialProviders: 20,
    providerGrowthRate: 0.0,
    providerExitThreshold: 0.001,
    demandVolume: 10,
    demandGrowth: 0.0,
    riskDistribution: { maxReliability: 0.20, balanced: 0.60, lowestCost: 0.20 },
    policyDistribution: { now: 1.0, waitForBetter: 0.0 },
    enableReputation: true,
    enableCommitments: true,
    enableIncentives: true,
    shockType: null,
    shockStep: 50,
    shockMagnitude: 0.5,
    baselineCostBps: 300,
  };
}

export function createWorld(config: SimConfig): SimWorld {
  return {
    config,
    step: 0,
    timeMs: 0,
    assets: new Map(),
    providers: new Map(),
    offers: new Map(),
    users: new Map(),
    intents: [],
    routes: new Map(),
    campaigns: new Map(),
    metricsHistory: [],
    totalVolume: 0,
    totalFees: 0,
    totalIncentives: 0,
    totalPenalties: 0,
    totalSlashing: 0,
  };
}
