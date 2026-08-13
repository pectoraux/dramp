// dRamp Network Simulator — World State
//
// In-memory simulation world. Does NOT touch the production database.
// All simulated entities are plain objects — no Prisma, no ledger mutations.

import { Decimal } from "@/lib/engine/money";

// FX valuation matrix: deterministic reference rates to USD for every asset.
// Used for cross-asset liquidity valuation, treasury accounting, and capital
// efficiency calculations. NOT a live FX market — just a static valuation layer.
//
// Rates are approximate real-world values (as of 2024). 1 unit of asset = rate USD.
export const FX_REFERENCE_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27,
  NGN: 0.00065,   // 1 NGN ≈ $0.00065 (~1500 NGN/USD)
  PHP: 0.017,     // 1 PHP ≈ $0.017 (~58 PHP/USD)
  KES: 0.0075,    // 1 KES ≈ $0.0075 (~133 KES/USD)
  SGD: 0.74,
  JPY: 0.0067,    // 1 JPY ≈ $0.0067 (~150 JPY/USD)
  INR: 0.012,     // 1 INR ≈ $0.012 (~83 INR/USD)
  BRL: 0.20,      // 1 BRL ≈ $0.20 (~5 BRL/USD)
  USDC: 1.0,
  EURC: 1.08,
  SC: 1.0,        // internal settlement unit, pegged to USD
  WETH: 2500.0,   // 1 WETH ≈ $2500
};

// Convert an asset amount to USD-equivalent value using the reference rates.
export function toUsdValue(asset: string, amount: number): number {
  const rate = FX_REFERENCE_RATES[asset];
  if (rate === undefined) return amount; // unknown asset: treat as 1:1
  return amount * rate;
}

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
  // Liquidity inventory: actual cash balances per asset, SEPARATE from collateral.
  // A provider can be well-collateralized but lack destination liquidity.
  liquidity: SimLiquidityInventory;
  // Treasury: finite source for liquidity replenishment. When a provider needs
  // more operating liquidity, it transfers from treasury → operating balance.
  // This CONSERVES money — no balances are created from nowhere.
  treasury: SimLiquidityInventory;
  // Total liquidity replenished from treasury (for metrics/auditing).
  totalReplenished: number;
  // Settlement reliability profile (stochastic settlement outcomes).
  // Derived from providerType, can be overridden per-provider.
  reliabilityProfile: SettlementReliabilityProfile;
  // Tracked economics (aggregate totals)
  totalVolume: number;
  totalEarnings: number;
  totalIncentives: number;
  totalPenalties: number;
  totalSlashing: number;
  executionsCompleted: number;
  executionsFailed: number;
  // Settlement outcome tracking (stochastic)
  settlementsFast: number;
  settlementsDelayed: number;
  settlementsRetried: number;
  settlementsFailed: number;
  utilization: number; // instantaneous reserved / available (observed during step)
  peakUtilization: number; // highest utilization seen over the simulation
  utilizationTimeSteps: number; // Σ (utilization per step) — for time-weighted average
  entryStep: number;
  exitStep: number | null;
  // Deployed capital tracking: sum of (amount × duration) across all executions.
  // Used for time-consistent capital cost calculation.
  totalDeployedCapitalSteps: number; // Σ (amount × steps_deployed) — capital-time product
  currentDeployedCapital: number; // currently reserved/deployed capital (across active reservations)
  // Per-execution history for faithful reputation recalculation.
  // Each record captures the amount, outcome, duration, and sim-time so the
  // shared calculateReputation function can apply recency + value weighting.
  executionHistory: SimExecutionRecord[];
}

// Liquidity inventory: a provider's actual cash balances, separate from
// collateral. A provider can have $1M collateral but only ₦10M local fiat —
// the collateral secures the network, but the fiat is needed to complete payouts.
//
// This is the most important economic distinction in cross-border payments:
//   collateral = risk security (locked, slashable)
//   source liquidity = cash the provider has to receive incoming transfers
//   destination liquidity = cash the provider has to pay out
export interface SimLiquidityInventory {
  // Per-asset balances. Keyed by asset symbol (e.g. "USD", "NGN", "USDC").
  // These are the provider's actual operating balances, NOT collateral.
  balances: Map<string, number>;
  // When a payout is made, destination liquidity decreases.
  // When a receipt is settled, source liquidity increases.
  // Providers replenish inventory periodically (configurable).
}

// Active reservation: capacity held for a multi-step settlement period.
// Created when an execution starts, released when the settlement duration
// elapses. This makes utilization real across steps.
export interface SimActiveReservation {
  id: string;
  offerId: string;
  providerId: string;
  amount: number;
  startStep: number;
  releaseStep: number; // startStep + settlementDurationSteps
}

// In-flight execution: an execution that has started but not yet settled.
// The intent is EXECUTING (not COMPLETED) until the settlement duration elapses.
// Liquidity is NOT consumed at start — only at settlement completion.
// This makes settlement delay affect BOTH user latency AND provider capital.
export interface SimInFlightExecution {
  id: string;
  intentId: string;
  routeId: string;
  legs: Array<{
    providerId: string;
    offerId: string;
    sourceAsset: string;
    destinationAsset: string;
    amount: number;
    rate: number;
    feeBps: number;
    payoutAmount: number;     // destination-asset amount to be paid at settlement
    providerName: string;
  }>;
  effectiveCost: number;
  netOutput: number;
  startStep: number;
  completionStep: number;     // startStep + max(leg durationSteps)
  settlementOutcome: "FAST" | "DELAYED" | "RETRY";
  // Reservations to release at completion.
  reservations: Array<{ offerId: string; providerId: string; amount: number }>;
}

// Settlement reliability profile: per-provider-type probability distribution
// for settlement outcomes. This makes settlement stochastic and gives
// reputation genuine economic meaning — reliable providers settle faster.
export interface SettlementReliabilityProfile {
  // Probability of fast settlement (settlementDurationSteps as advertised)
  fastRate: number;      // 0..1, e.g. 0.95
  // Probability of delayed settlement (2× advertised duration)
  delayedRate: number;   // 0..1, e.g. 0.03
  // Probability of retry (3× advertised duration, capital held longer)
  retryRate: number;     // 0..1, e.g. 0.01
  // Probability of failure (capital released, intent fails)
  failureRate: number;   // 0..1, e.g. 0.01
}

// Default reliability profiles by provider type.
export const DEFAULT_RELIABILITY_PROFILES: Record<string, SettlementReliabilityProfile> = {
  BANK: { fastRate: 0.98, delayedRate: 0.015, retryRate: 0.003, failureRate: 0.002 },
  PSP: { fastRate: 0.95, delayedRate: 0.03, retryRate: 0.01, failureRate: 0.01 },
  CEX: { fastRate: 0.93, delayedRate: 0.04, retryRate: 0.015, failureRate: 0.015 },
  DEX: { fastRate: 0.90, delayedRate: 0.05, retryRate: 0.02, failureRate: 0.03 },
  STABLECOIN_LP: { fastRate: 0.96, delayedRate: 0.025, retryRate: 0.008, failureRate: 0.007 },
  LOCAL_FIAT_AGENT: { fastRate: 0.85, delayedRate: 0.08, retryRate: 0.03, failureRate: 0.04 },
  MARKET_MAKER: { fastRate: 0.94, delayedRate: 0.035, retryRate: 0.012, failureRate: 0.013 },
  TREASURY: { fastRate: 0.97, delayedRate: 0.02, retryRate: 0.005, failureRate: 0.005 },
  SETTLEMENT_ASSET_SPONSOR: { fastRate: 0.92, delayedRate: 0.05, retryRate: 0.015, failureRate: 0.015 },
  HYBRID: { fastRate: 0.91, delayedRate: 0.05, retryRate: 0.02, failureRate: 0.02 },
};

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
  // Settlement duration in simulation steps. Capital is reserved for this
  // many steps before being released. Derived from expectedExecutionSeconds
  // and the simulation stepDurationMs.
  settlementDurationSteps: number;
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
  // Demand patience (Prompt 4.5): customers abandon if price/latency exceeds limits.
  maxAcceptablePriceBps: number;     // max total cost in bps; abandon if route exceeds this
  maxAcceptableLatencySteps: number; // max wait in steps before abandonment
  status: string; // SEARCHING | EXECUTING | COMPLETED | FAILED | CANCELLED | EXPIRED | ABANDONED
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
  abandonedIntents: number;       // Prompt 4.5: customer abandonment (price/latency)
  liquidityConstrainedFailures: number; // Prompt 4.5: failures due to insufficient destination liquidity
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
  peakUtilization: number;       // highest instantaneous utilization across all providers
  avgTimeWeightedUtilization: number; // time-weighted average (utilizationTimeSteps / elapsedSteps)
  totalProviderVolume: number;
  totalProtocolRevenue: number;
  totalIncentiveSpend: number;
  // Settlement lifecycle metrics (P4.6)
  inFlightExecutions: number;          // currently executing (not yet settled)
  avgSettlementLatencySteps: number;   // average settlement duration
  p50SettlementLatencySteps: number;
  p95SettlementLatencySteps: number;
  totalLiquidityReplenished: number;   // treasury → operating transfers
  totalExternalLiquidityInjected: number; // external injections (scenario events)
  // Provider economics (simulation-period, NOT annualized)
  medianNetProfit: number;           // $ net earnings (sim period)
  avgNetProfit: number;              // $ net earnings (sim period)
  medianNetMargin: number;           // % net margin (netEarnings / grossEarnings)
  medianProfitPerExecution: number;  // $ net earnings per execution
  medianAnnualizedReturnPct: number; // modeled extrapolation (labeled, not primary)
  medianCapitalEfficiency: number;   // settledVolume / averageLockedCapital (turnover ratio)
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
  // Active reservations: capacity held for multi-step settlement periods.
  // These persist across steps until releaseStep, making utilization real.
  activeReservations: SimActiveReservation[];
  // In-flight executions: executions that have started but not yet settled.
  // The intent is EXECUTING (not COMPLETED) until settlement completes.
  // Liquidity is NOT consumed at start — only at settlement completion.
  inFlightExecutions: SimInFlightExecution[];
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
  // ---- Prompt 4.5: Liquidity & Settlement Realism ----
  // All new assumptions are EXPLICITLY exposed here — no silent defaults.
  // Setting enableLiquidityInventory=false reverts to P4.4 behavior (capacity-only).
  enableLiquidityInventory: boolean;  // if true, routing checks destination liquidity
  enableStochasticSettlement: boolean; // if true, settlement outcomes are probabilistic
  enableDemandPatience: boolean;       // if true, customers abandon on price/latency
  // Demand patience defaults (per-intent values sampled from these).
  defaultMaxAcceptablePriceBps: number;   // e.g. 400 = 4% max cost
  defaultMaxAcceptableLatencySteps: number; // e.g. 30 = 30 min max wait
  // Liquidity replenishment: providers top up inventory every N steps.
  liquidityReplenishSteps: number;
}

export function createDefaultConfig(): SimConfig {
  return {
    seed: 42,
    totalSteps: 100,
    stepDurationMs: 60000, // 1 minute per step — economically meaningful unit
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
    // Prompt 4.5: Liquidity & Settlement Realism (all explicit, versioned)
    enableLiquidityInventory: true,
    enableStochasticSettlement: true,
    enableDemandPatience: true,
    defaultMaxAcceptablePriceBps: 400,   // 4% max cost
    defaultMaxAcceptableLatencySteps: 30, // 30 min max wait
    liquidityReplenishSteps: 10,
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
    stepDurationMs: 60000, // 1 minute per step
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
    // Prompt 4.5: Liquidity & Settlement Realism (all explicit, versioned)
    enableLiquidityInventory: true,
    enableStochasticSettlement: true,
    enableDemandPatience: true,
    defaultMaxAcceptablePriceBps: 400,
    defaultMaxAcceptableLatencySteps: 30,
    liquidityReplenishSteps: 10,
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
    activeReservations: [],
    inFlightExecutions: [],
    metricsHistory: [],
    totalVolume: 0,
    totalFees: 0,
    totalIncentives: 0,
    totalPenalties: 0,
    totalSlashing: 0,
  };
}
