// dRamp Prompt 4.8.8 — Production-Faithful Path Reachability
//
// Builds on Prompt 4.8.3 (independent replicates, frozen demand, deep clone).
// Key change: the experiment now answers the SAME routing question as the
// actual dRamp engine:
//
//   "Given the exact same demand, can the actual dRamp routing engine assemble
//    sufficient liquidity across providers and hops to execute it?"
//
// Fixes (Prompt 4.8.8):
//   1. Extracts computeHopOutput(), coverAmount(), enumeratePaths() into the
//      canonical shared economics layer. Production routing.ts and this
//      experiment import the SAME functions. No duplicate formula.
//   2. Production-faithful route feasibility: enumeratePaths (maxHops=4),
//      coverAmount (split-capacity), computeHopOutput (hop propagation),
//      hard filters (provider status, min/max, settlement-asset risk ceiling,
//      counterparty risk ceiling — per user's ACTUAL risk tolerance),
//      liquidity (each hop's provider holds enough destination asset).
//   3. Split-capacity support: 6k + 4k satisfies 10k demand.
//   4. Multi-hop up to maxHops=4 (direct / 2-hop / 3-hop / 4-hop).
//   5. Route-composition metrics: direct (single) / split direct / 2-hop / 3+-hop.
//
// Controls preserved from 4.8.3-4.8.7:
//   - Frozen demand per seed (independent RNG stream from providers)
//   - Canonical 100-provider pool per seed (deep-cloned per run)
//   - Per-seed demand-derived corridors for CORRIDOR_FOCUSED topology
//   - Frozen provider economics (including liquidity/treasury) across topologies
//   - No entry/exit, no incentives, no shocks
//
// Usage: bun experiments/p4-topology-experiment.ts

import { simulateStep } from "../src/lib/simulator/engine-faithful";
import { createWorld, createDefaultConfig } from "../src/lib/simulator/world";
import { SeededRNG } from "../src/lib/simulator/rng";
import {
  SimWorld, SimConfig, SimProvider, SimOffer, SimUser, SimSettlementAsset,
  SimLiquidityInventory, SettlementReliabilityProfile,
  DEFAULT_RELIABILITY_PROFILES,
} from "../src/lib/simulator/world";
import {
  calculateProviderEconomics, settlementAssetRisk, assetRiskCeiling, counterpartyRiskCeiling,
  providerCounterpartyRisk, computeHopOutput, coverAmount, enumeratePaths,
  type CoverOffer, type AdjacencyEdge, type PathStep,
} from "../src/lib/economics/shared";

// ---- Constants ----
const COUNTRIES = ["US", "EU", "NG", "PH", "KE", "GB", "SG", "JP", "IN", "BR"];
const ASSETS = ["USD", "EUR", "NGN", "PHP", "KES", "GBP", "SGD", "JPY", "INR", "BRL"];
const PROVIDER_TYPES = ["LOCAL_FIAT_AGENT", "PSP", "BANK", "CEX", "DEX", "STABLECOIN_LP", "MARKET_MAKER", "TREASURY"];
const TRUST_MODELS = ["COLLATERALIZED", "INSTITUTIONALLY_TRUSTED", "PRE_FUNDED", "NON_CUSTODIAL"];
const STRATEGIES = ["AGGRESSIVE", "PREMIUM", "LIQUIDITY_MAXIMIZER", "MARKET_MAKER", "INCENTIVE_SEEKER", "CONSERVATIVE", "OPPORTUNISTIC"];
const PROVIDER_NAMES = ["Northbridge", "SwiftPay", "Meridian", "Atlas", "OpenSwap", "Sahara", "Continental", "Pacific", "GlobalBridge", "TransContinental", "FastCorridor", "LiquidityHub", "CapitalFlow", "EdgeExchange", "DirectRoute", "PrimeLiquidity", "ValueBridge", "SpeedTransfer", "TrustFlow", "OpenMarket"];

// Production-faithful routing: same maxHops as production's findRoutes() default.
const MAX_HOPS = 4;
// Demand sampling: for corridors with many demands, check a representative
// sample (evenly spaced by amount) rather than every demand. This preserves
// the demand-weight distribution while cutting per-corridor cost ~10x.
// Feasibility is approximately monotonic in amount (larger = harder), so
// evenly-spaced sampling captures the feasibility threshold accurately.
const MAX_DEMANDS_FULL = 8;   // full mode (breakdown): 8 samples per corridor
const MAX_DEMANDS_TOTAL = 4;  // total mode (time-series): 4 samples per corridor
// Path limit per tier: cap the number of paths checked per hop-count tier.
// With maxHops=4 on a 100-provider graph, enumeratePaths can generate hundreds
// of paths per corridor. For infeasible demands (the majority), all paths get
// checked. Capping at 15 per tier bounds the worst case while still finding
// feasible paths in virtually all real cases (the shortest 15 paths are checked
// first, sorted by hop count).
const MAX_PATHS_PER_TIER = 15;

let idCounter = 0;
function nextId(prefix: string): string { return `${prefix}_${++idCounter}`; }

type TopologyMode = "RANDOM" | "CORRIDOR_FOCUSED" | "BRIDGED";

// ---- Immutable provider specification (template, never mutated) ----
interface ProviderSpec {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  strategy: string;
  collateral: number;
  usableCollateral: number;
  maxExposure: number;
  corridors: string[];
  reliabilityProfile: SettlementReliabilityProfile;
  // Initial balances (immutable template)
  liquidityBalances: Map<string, number>;
  treasuryBalances: Map<string, number>;
  // Offer specs (immutable template)
  offerSpecs: Array<{
    sourceAsset: string;
    destinationAsset: string;
    sourceCountry: string;
    destinationCountry: string;
    rate: number;
    feeBps: number;
    settlementAssetId: string;
    availableCapacity: number;
    expectedExecutionSeconds: number;
  }>;
}

// ---- Deep clone a ProviderSpec into a fresh SimProvider + SimOffers ----
export function cloneProvider(spec: ProviderSpec): { provider: SimProvider; offers: SimOffer[] } {
  // Deep-copy all mutable maps.
  const liquidity = new Map<string, number>(spec.liquidityBalances);
  const treasury = new Map<string, number>(spec.treasuryBalances);
  const encumbered = new Map<string, number>();

  const provider: SimProvider = {
    id: spec.id, name: spec.name, providerType: spec.providerType, trustModel: spec.trustModel,
    reputationScore: 0.7, // will be set by reputation calc; initial neutral
    tier: "VERIFIED", status: "ACTIVE", exitReason: null,
    strategy: spec.strategy, collateral: spec.collateral, usableCollateral: spec.usableCollateral,
    lockedCollateral: 0, maxExposure: spec.maxExposure, corridors: [...spec.corridors],
    liquidity: { balances: liquidity },
    encumbered: { balances: encumbered },
    treasury: { balances: treasury },
    totalReplenished: 0,
    reliabilityProfile: { ...spec.reliabilityProfile },
    totalVolume: 0, totalEarnings: 0, totalIncentives: 0, totalPenalties: 0, totalSlashing: 0,
    executionsCompleted: 0, executionsFailed: 0,
    settlementsFast: 0, settlementsDelayed: 0, settlementsRetried: 0, settlementsFailed: 0,
    utilization: 0, peakUtilization: 0, utilizationTimeSteps: 0,
    entryStep: 0, exitStep: null, totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
    executionHistory: [],
  };

  const offers: SimOffer[] = spec.offerSpecs.map(os => ({
    id: nextId("offer"), providerId: spec.id,
    capability: "FIAT_IN", sourceAsset: os.sourceAsset, destinationAsset: os.destinationAsset,
    sourceCountry: os.sourceCountry, destinationCountry: os.destinationCountry,
    rate: os.rate, feeBps: os.feeBps, minimumAmount: 10, maximumAmount: 1000000000,
    availableCapacity: os.availableCapacity, reservedCapacity: 0,
    settlementAssetId: os.settlementAssetId, channelType: "AUTOMATIC",
    expectedExecutionSeconds: os.expectedExecutionSeconds,
    incentiveBps: 0, active: true, version: 1,
    settlementDurationSteps: 1,
  }));

  return { provider, offers };
}

// ---- Generate demand population (frozen, uses dedicated RNG) ----
export function generateDemandPopulation(seed: number, numUsers: number, config: SimConfig): SimUser[] {
  const rng = new SeededRNG(seed);
  const users: SimUser[] = [];
  for (let i = 0; i < numUsers; i++) {
    const srcIdx = rng.int(0, ASSETS.length - 1);
    let dstIdx = rng.int(0, ASSETS.length - 1);
    while (dstIdx === srcIdx) dstIdx = rng.int(0, ASSETS.length - 1);
    const riskRoll = rng.next();
    let riskTolerance: string;
    if (riskRoll < config.riskDistribution.maxReliability) riskTolerance = "MAX_RELIABILITY";
    else if (riskRoll < config.riskDistribution.maxReliability + config.riskDistribution.balanced) riskTolerance = "BALANCED";
    else riskTolerance = "LOWEST_COST";
    const policyRoll = rng.next();
    const executionPolicy = policyRoll < config.policyDistribution.now ? "NOW" : "WAIT_FOR_BETTER";
    const sizeBucket = rng.weighted([0.3, 0.4, 0.2, 0.1]);
    const sizes = [[20, 200], [200, 2000], [2000, 20000], [20000, 100000]];
    const [minAmt, maxAmt] = sizes[sizeBucket];
    const typicalAmount = rng.float(minAmt, maxAmt);
    users.push({
      id: `user_${i}`, name: `User ${i + 1}`,
      sourceCountry: COUNTRIES[srcIdx], destinationCountry: COUNTRIES[dstIdx],
      sourceAsset: ASSETS[srcIdx], destinationAsset: ASSETS[dstIdx],
      typicalAmount, amountStdDev: typicalAmount * 0.2,
      frequency: rng.float(0.05, 0.3), riskTolerance, executionPolicy,
      maxWaitSeconds: executionPolicy === "WAIT_FOR_BETTER" ? rng.int(60, 600) : 0,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
    });
  }
  return users;
}

// ---- Derive demand corridors from a frozen demand population ----
export function deriveDemandCorridors(users: SimUser[]): Array<[string, string, string, string]> {
  const corridorDemand = new Map<string, { srcAsset: string; srcCountry: string; dstAsset: string; dstCountry: string; weight: number }>();
  for (const u of users) {
    const key = `${u.sourceAsset}:${u.sourceCountry}:${u.destinationAsset}:${u.destinationCountry}`;
    const existing = corridorDemand.get(key);
    const weight = u.frequency * u.typicalAmount;
    if (existing) existing.weight += weight;
    else corridorDemand.set(key, { srcAsset: u.sourceAsset, srcCountry: u.sourceCountry, dstAsset: u.destinationAsset, dstCountry: u.destinationCountry, weight });
  }
  return [...corridorDemand.values()].sort((a, b) => b.weight - a.weight)
    .map(c => [c.srcAsset, c.srcCountry, c.dstAsset, c.dstCountry] as [string, string, string, string]);
}

// ---- Generate immutable provider ECONOMICS (shared across topologies) ----
// Provider type, strategy, collateral, reliability, pricing, AND initial liquidity/treasury
// are generated ONCE per seed and are IDENTICAL across all topology treatments.
// Only the corridor/offer assignment differs by topology.
// Starting liquidity is generated from a FIXED set of assets (not topology-dependent)
// so that topology is the ONLY treatment difference.
interface ProviderEconomics {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  strategy: string;
  collateral: number;
  usableCollateral: number;
  maxExposure: number;
  reliabilityProfile: SettlementReliabilityProfile;
  feeBps: number;
  rate: number;
  capacity: number;
  expectedExecutionSeconds: number;
  // FIXED starting liquidity/treasury (same across topologies).
  liquidityBalances: Map<string, number>;
  treasuryBalances: Map<string, number>;
}

function generateProviderEconomics(seed: number, count: number, settlementAssets: Map<string, SimSettlementAsset>): ProviderEconomics[] {
  const rng = new SeededRNG(seed);
  const economics: ProviderEconomics[] = [];
  const stableAssetList = [...settlementAssets.values()].filter(a => a.isEligibleCollateral);
  // Fixed set of assets for initial liquidity (same for all topologies).
  const allAssetSymbols = [...ASSETS, ...stableAssetList.map(a => a.symbol)];

  for (let i = 0; i < count; i++) {
    const providerType = rng.pick(PROVIDER_TYPES);
    const strategy = rng.pick(STRATEGIES);
    const trustModel = rng.pick(TRUST_MODELS);
    const name = `${PROVIDER_NAMES[i % PROVIDER_NAMES.length]} ${String.fromCharCode(65 + (i % 26))}`;
    const collateral = rng.float(10000, 100000);
    const collateralHaircut = rng.pick(stableAssetList).collateralHaircut;
    const usableCollateral = collateral * (1 - collateralHaircut);
    const maxExposure = usableCollateral / 1.5;

    const baseProfile = DEFAULT_RELIABILITY_PROFILES[providerType] ?? DEFAULT_RELIABILITY_PROFILES.HYBRID;
    const variation = rng.float(-0.02, 0.02);
    const reliabilityProfile: SettlementReliabilityProfile = {
      fastRate: Math.max(0.5, Math.min(0.999, baseProfile.fastRate + variation)),
      delayedRate: Math.max(0, baseProfile.delayedRate - variation * 0.5),
      retryRate: Math.max(0, baseProfile.retryRate - variation * 0.3),
      failureRate: Math.max(0, baseProfile.failureRate - variation * 0.2),
    };

    // Generate FIXED liquidity/treasury (independent of topology).
    // Each provider gets liquidity in 2-4 random assets + 1-2 settlement assets.
    const liquidityBalances = new Map<string, number>();
    const treasuryBalances = new Map<string, number>();
    const numAssets = rng.int(2, 4);
    const usedAssets = new Set<string>();
    for (let a = 0; a < numAssets; a++) {
      const asset = rng.pick(allAssetSymbols);
      if (usedAssets.has(asset)) continue;
      usedAssets.add(asset);
      liquidityBalances.set(asset, collateral * rng.float(0.1, 0.4));
      treasuryBalances.set(asset, collateral * rng.float(0.3, 0.8));
    }
    // Also add some settlement-asset liquidity.
    const sa = rng.pick(stableAssetList);
    liquidityBalances.set(sa.symbol, (liquidityBalances.get(sa.symbol) ?? 0) + collateral * 0.2);
    treasuryBalances.set(sa.symbol, (treasuryBalances.get(sa.symbol) ?? 0) + collateral * 0.5);

    economics.push({
      id: `prov_${i}`, name, providerType, trustModel, strategy,
      collateral, usableCollateral, maxExposure, reliabilityProfile,
      feeBps: rng.int(5, 35), rate: rng.float(0.8, 1.2),
      capacity: rng.float(5000, 50000), expectedExecutionSeconds: rng.int(10, 120),
      liquidityBalances, treasuryBalances,
    });
  }
  return economics;
}

// ---- Assign topology-specific corridors to shared provider economics ----
export function generateCanonicalSpecs(
  seed: number, count: number, topology: TopologyMode,
  settlementAssets: Map<string, SimSettlementAsset>,
  demandDerivedCorridors: Array<[string, string, string, string]>,
): ProviderSpec[] {
  // Generate shared economics ONCE (identical across topologies for same seed).
  const economics = generateProviderEconomics(seed, count, settlementAssets);
  // Use a SEPARATE RNG for topology-specific corridor assignment.
  const rng = new SeededRNG(seed + 77777);
  const specs: ProviderSpec[] = [];
  const stableAssetList = [...settlementAssets.values()].filter(a => a.isEligibleCollateral);

  for (let i = 0; i < count; i++) {
    const econ = economics[i];
    const corridors: string[] = [];
    const offerSpecs: ProviderSpec["offerSpecs"] = [];

    if (topology === "RANDOM") {
      const numCorridors = rng.int(1, 3);
      const usedPairs = new Set<string>();
      for (let c = 0; c < numCorridors; c++) {
        let srcIdx: number, dstIdx: number;
        do { srcIdx = rng.int(0, ASSETS.length - 1); dstIdx = rng.int(0, ASSETS.length - 1); }
        while (srcIdx === dstIdx || usedPairs.has(`${srcIdx}-${dstIdx}`));
        usedPairs.add(`${srcIdx}-${dstIdx}`);
        corridors.push(`${ASSETS[srcIdx]}:${COUNTRIES[srcIdx]}:${ASSETS[dstIdx]}:${COUNTRIES[dstIdx]}`);
        const settlementAsset = rng.pick(stableAssetList);
        offerSpecs.push({
          sourceAsset: ASSETS[srcIdx], destinationAsset: ASSETS[dstIdx],
          sourceCountry: COUNTRIES[srcIdx], destinationCountry: COUNTRIES[dstIdx],
          rate: econ.rate, feeBps: econ.feeBps, settlementAssetId: settlementAsset.id,
          availableCapacity: econ.capacity, expectedExecutionSeconds: econ.expectedExecutionSeconds,
        });
      }
    } else if (topology === "CORRIDOR_FOCUSED") {
      const numCorridors = rng.int(1, 3);
      for (let c = 0; c < numCorridors; c++) {
        const corridor = rng.pick(demandDerivedCorridors);
        corridors.push(`${corridor[0]}:${corridor[1]}:${corridor[2]}:${corridor[3]}`);
        const settlementAsset = rng.pick(stableAssetList);
        offerSpecs.push({
          sourceAsset: corridor[0], destinationAsset: corridor[2],
          sourceCountry: corridor[1], destinationCountry: corridor[3],
          rate: econ.rate, feeBps: econ.feeBps, settlementAssetId: settlementAsset.id,
          availableCapacity: econ.capacity, expectedExecutionSeconds: econ.expectedExecutionSeconds,
        });
      }
    } else if (topology === "BRIDGED") {
      const role = rng.next();
      if (role < 0.5) {
        const corridor = rng.pick(demandDerivedCorridors);
        corridors.push(`${corridor[0]}:${corridor[1]}:${corridor[2]}:${corridor[3]}`);
        const settlementAsset = rng.pick(stableAssetList);
        offerSpecs.push({
          sourceAsset: corridor[0], destinationAsset: corridor[2],
          sourceCountry: corridor[1], destinationCountry: corridor[3],
          rate: econ.rate, feeBps: econ.feeBps, settlementAssetId: settlementAsset.id,
          availableCapacity: econ.capacity, expectedExecutionSeconds: econ.expectedExecutionSeconds,
        });
      } else {
        const sa = rng.pick(stableAssetList);
        const fiatIdx = rng.int(0, ASSETS.length - 1);
        const fiatAsset = ASSETS[fiatIdx];
        const fiatCountry = COUNTRIES[fiatIdx];
        if (rng.chance(0.5)) {
          corridors.push(`${fiatAsset}:${fiatCountry}:${sa.symbol}:GLOBAL`);
          offerSpecs.push({ sourceAsset: fiatAsset, destinationAsset: sa.symbol, sourceCountry: fiatCountry, destinationCountry: "GLOBAL", rate: econ.rate, feeBps: econ.feeBps, settlementAssetId: sa.id, availableCapacity: econ.capacity, expectedExecutionSeconds: econ.expectedExecutionSeconds });
        } else {
          corridors.push(`${sa.symbol}:GLOBAL:${fiatAsset}:${fiatCountry}`);
          offerSpecs.push({ sourceAsset: sa.symbol, destinationAsset: fiatAsset, sourceCountry: "GLOBAL", destinationCountry: fiatCountry, rate: econ.rate, feeBps: econ.feeBps, settlementAssetId: sa.id, availableCapacity: econ.capacity, expectedExecutionSeconds: econ.expectedExecutionSeconds });
        }
      }
    }

    // Use FROZEN liquidity/treasury from shared economics (not corridor-derived).
    const liquidityBalances = new Map(econ.liquidityBalances);
    const treasuryBalances = new Map(econ.treasuryBalances);

    specs.push({
      id: econ.id, name: econ.name, providerType: econ.providerType, trustModel: econ.trustModel,
      strategy: econ.strategy, collateral: econ.collateral, usableCollateral: econ.usableCollateral,
      maxExposure: econ.maxExposure, corridors, reliabilityProfile: econ.reliabilityProfile,
      liquidityBalances, treasuryBalances, offerSpecs,
    });
  }
  return specs;
}

// ---- Build a world from frozen demand + deep-cloned providers ----
export function buildWorld(
  seed: number, providerCount: number, topology: TopologyMode,
  demandPopulation: SimUser[], canonicalSpecs: ProviderSpec[],
  config: SimConfig,
): SimWorld {
  idCounter = 0;
  const world = createWorld(config);

  // Settlement assets (deterministic).
  const settlementAssets: [string, SimSettlementAsset][] = [
    ["asset_usdc", { id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_eurc", { id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_sc", { id: "asset_sc", symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT", volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0, incentiveRate: 0, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_weth", { id: "asset_weth", symbol: "WETH", assetType: "VOLATILE_TOKEN", volatilityScore: 0.6, liquidityScore: 0.6, pegQuality: null, incentiveRate: 0, collateralHaircut: 0.5, isEligibleCollateral: false, status: "ACTIVE" }],
  ];
  for (const [id, sa] of settlementAssets) world.assets.set(id, sa);

  // Deep-clone providers from immutable specs (fresh state per run).
  for (let i = 0; i < providerCount; i++) {
    const spec = canonicalSpecs[i];
    const { provider, offers } = cloneProvider(spec);
    world.providers.set(provider.id, provider);
    for (const offer of offers) world.offers.set(offer.id, offer);
  }

  // Compute settlement durations.
  const stepSeconds = config.stepDurationMs / 1000;
  for (const o of world.offers.values()) {
    o.settlementDurationSteps = Math.max(1, Math.ceil(o.expectedExecutionSeconds / stepSeconds));
  }

  // Add frozen demand population.
  for (const user of demandPopulation) world.users.set(user.id, user);

  return world;
}

// ---- Production-faithful path feasibility (Prompt 4.8.8) ----------------
//
// Mirrors production's buildCandidateRoute + applyHardFilters + execution-time
// liquidity check. For a given path (sequence of hops) and demand amount:
//   1. Propagate the amount through hops via shared coverAmount + computeHopOutput.
//   2. Apply hard filters: provider status, min/max limits, settlement-asset
//      risk ceiling, counterparty risk ceiling (per user's ACTUAL risk tolerance).
//   3. Apply liquidity: each hop's provider must hold enough of that hop's
//      destination asset (production checks this at execution time; the
//      experiment checks it for feasibility).
//
// Returns null if the path is structurally infeasible (coverAmount fails).
// Otherwise returns { liqFeasible, prodFeasible, split }:
//   - liqFeasible: passes capacity + min/max + provider status + liquidity.
//   - prodFeasible: passes liqFeasible + risk ceilings.
//   - split: true if coverAmount split the amount across multiple offers on any hop.

export interface PathFeasibility {
  liqFeasible: boolean;
  prodFeasible: boolean;
  split: boolean;
}

// (Prompt 4.8.8N) Staged feasibility with downstream-aware alternative search.
export interface StagedFeasibility {
  capacityFeasible: boolean;    // B: coverAmount succeeds
  liquidityFeasible: boolean;   // C: + destination liquidity (output-aware, greedy coverAmount)
  productionFeasible: boolean;  // D: + risk ceilings + min/max + provider status (greedy)
  split: boolean;
  failureReason: "none" | "capacity" | "liquidity" | "minMax" | "providerStatus" | "risk" | "providerMissing";
  inventoryFeasible: boolean;            // C': SOME assignment has liquidity (ignores risk)
  alternativeProductionFeasible: boolean; // D': SOME assignment satisfies ALL constraints
}

// (Prompt 4.8.8N) Check if there exists ANY assignment across parallel offers
// that satisfies ALL production constraints, using downstream-aware search.
// This is the true alternative-production feasibility — the upper bound on
// what inventory-aware routing could achieve.
//
// The search uses breakpoint-based allocation with downstream propagation:
// for each candidate split on hop N, the actual output is computed and passed
// to hop N+1. If downstream fails, backtrack and try a different split.
//
// Breakpoints are derived from economically meaningful values:
//   0, minimumAmount, maxViable, remaining, and downstream-constrained amounts.
//
// Downstream-constrained breakpoints: for multi-hop paths, the amount allocated
// to offer X on hop N affects the total hop output, which must be feasible for
// hop N+1. The critical breakpoints are where the total output crosses
// downstream min/max/liquidity thresholds.
export function checkAlternativeProductionFeasibility(
  path: PathStep<SimOffer>[],
  amount: number,
  riskTolerance: string,
  world: SimWorld,
  saRiskCache: Map<string, number>,
  cpRiskCache: Map<string, number>,
): boolean {
  // Precompute offer info for each hop.
  const hopInfos = path.map((step) => {
    return step.edges
      .map((o) => {
        const prodCap = toProductionCapacity({
          availableCapacity: o.availableCapacity,
          reservedCapacity: o.reservedCapacity,
        });
        const usableCap = prodCap.availableCapacity - prodCap.reservedCapacity;
        const provider = world.providers.get(o.providerId);
        const dstLiquidity = provider?.liquidity?.balances?.get(o.destinationAsset) ?? 0;
        let riskOK = true;
        if (provider && provider.status === "ACTIVE") {
          if (o.settlementAssetId) {
            const saRisk = saRiskCache.get(o.settlementAssetId);
            if (saRisk !== undefined && saRisk > assetRiskCeiling(riskTolerance)) riskOK = false;
          }
          const cpRisk = cpRiskCache.get(provider.id);
          if (cpRisk !== undefined && cpRisk > counterpartyRiskCeiling(riskTolerance)) riskOK = false;
        }
        const outputMultiplier = (1 - o.feeBps / 10000) * o.rate * (1 + (o.incentiveBps ?? 0) / 10000);
        const liquidityLimit = outputMultiplier > 0 ? dstLiquidity / outputMultiplier : 0;
        const maxViable = Math.min(usableCap, liquidityLimit, o.maximumAmount);
        return {
          offer: o, provider, usableCap, dstLiquidity, liquidityLimit, maxViable,
          outputMultiplier, minimumAmount: o.minimumAmount, maximumAmount: o.maximumAmount,
          feeBps: o.feeBps, rate: o.rate, incentiveBps: o.incentiveBps ?? 0,
          statusOK: provider?.status === "ACTIVE", riskOK,
        };
      })
      .filter((x) => x.provider && x.statusOK && x.usableCap > 0 && x.riskOK && x.maxViable >= x.minimumAmount);
  });

  // Compute downstream constraints for breakpoint generation.
  // For hop i, the downstream min/max are the minimum/maximum amounts that
  // hop i+1 can accept. If hop i+1 has offers with min=15k, then hop i's
  // total output must be ≥ 15k.
  function getDownstreamMin(i: number): number {
    if (i + 1 >= hopInfos.length) return 0;
    const nextOffers = hopInfos[i + 1];
    if (nextOffers.length === 0) return 0;
    // The minimum total output from hop i that could be feasible downstream
    // is the minimum amount of any single offer on hop i+1.
    return Math.min(...nextOffers.map((x) => x.minimumAmount));
  }

  function getDownstreamMax(i: number): number {
    if (i + 1 >= hopInfos.length) return Infinity;
    const nextOffers = hopInfos[i + 1];
    if (nextOffers.length === 0) return 0;
    // The maximum total output from hop i that could be feasible downstream
    // is the sum of all maxViable on hop i+1.
    return nextOffers.reduce((s, x) => s + x.maxViable, 0);
  }

  // Generate candidate allocation amounts for an offer, including
  // downstream-constrained breakpoints.
  function getCandidateAmounts(
    offerIdx: number,
    hopIdx: number,
    remaining: number,
    offers: typeof hopInfos[number],
  ): number[] {
    const x = offers[offerIdx];
    const candidates = new Set<number>();

    // 0: skip
    candidates.add(0);

    // minimumAmount
    if (x.minimumAmount <= x.maxViable && x.minimumAmount <= remaining) {
      candidates.add(x.minimumAmount);
    }

    // maxViable (capped at remaining)
    const maxTake = Math.min(remaining, x.maxViable);
    if (maxTake >= x.minimumAmount) {
      candidates.add(maxTake);
    }

    // remaining (if ≤ maxViable)
    if (remaining <= x.maxViable && remaining >= x.minimumAmount) {
      candidates.add(remaining);
    }

    // Downstream-constrained breakpoints:
    // The total hop output = Σ(alloc_j * outputMultiplier_j).
    // If this offer has outputMultiplier m_j and takes amount a_j,
    // and other offers take amounts that sum to S_input with outputMultiplier M_avg,
    // then total output ≈ a_j * m_j + (remaining - a_j) * M_avg_other.
    //
    // For 2-offer splits (the most common case), this is exact:
    // total_output = a * m_a + (remaining - a) * m_b
    // We need total_output ∈ [downstreamMin, downstreamMax].
    // So: a * m_a + (remaining - a) * m_b >= downstreamMin
    //     a * (m_a - m_b) >= downstreamMin - remaining * m_b
    //     a >= (downstreamMin - remaining * m_b) / (m_a - m_b)  [if m_a > m_b]
    //     a <= (downstreamMax - remaining * m_b) / (m_a - m_b)  [if m_a < m_b]
    const dsMin = getDownstreamMin(hopIdx);
    const dsMax = getDownstreamMax(hopIdx);

    if (offers.length === 2 && offerIdx === 0) {
      const other = offers[1];
      const mA = x.outputMultiplier;
      const mB = other.outputMultiplier;
      if (mA !== mB) {
        // a * mA + (remaining - a) * mB >= dsMin
        // a >= (dsMin - remaining * mB) / (mA - mB)
        const denom = mA - mB;
        if (Math.abs(denom) > 1e-12) {
          const aMin = (dsMin - remaining * mB) / denom;
          if (aMin >= x.minimumAmount && aMin <= maxTake && aMin > 0) {
            candidates.add(aMin);
          }
          const aMax = (dsMax - remaining * mB) / denom;
          if (aMax >= x.minimumAmount && aMax <= maxTake && aMax > 0) {
            candidates.add(aMax);
          }
        }
      }
    }

    // remaining - maxViable_of_next_offer
    if (offerIdx + 1 < offers.length) {
      const nextMax = offers[offerIdx + 1].maxViable;
      const needed = remaining - nextMax;
      if (needed >= x.minimumAmount && needed <= x.maxViable && needed > 0) {
        candidates.add(needed);
      }
      // remaining - sum of ALL remaining offers' maxViable
      let sumRestMax = 0;
      for (let j = offerIdx + 1; j < offers.length; j++) sumRestMax += offers[j].maxViable;
      const minNeeded = remaining - sumRestMax;
      if (minNeeded >= x.minimumAmount && minNeeded <= x.maxViable && minNeeded > 0) {
        candidates.add(minNeeded);
      }
    }

    // Filter to valid range and return sorted.
    return [...candidates]
      .filter((a) => a >= 0 && a <= remaining + 1e-9 && (a === 0 || (a >= x.minimumAmount && a <= x.maxViable)))
      .sort((a, b) => b - a); // try larger amounts first (more likely to cover remaining)
  }

  // Recursive split enumeration with downstream backtracking.
  // (Prompt 4.8.8N) CRITICAL FIX: enumerateSplits must try ALL candidate
  // amounts and return multiple possible outputs, not just the first one.
  // The caller (tryHop) then tries each output downstream and backtracks
  // if it fails. This is what makes the search downstream-aware.
  function enumerateSplits(
    hopIdx: number,
    offerIdx: number,
    remaining: number,
    outputSoFar: number,
  ): { output: number }[] {
    if (remaining <= 0.000001) return [{ output: outputSoFar }];
    if (offerIdx >= hopInfos[hopIdx].length) return [];

    const offers = hopInfos[hopIdx];
    const candidates = getCandidateAmounts(offerIdx, hopIdx, remaining, offers);
    const results: { output: number }[] = [];

    for (const amt of candidates) {
      const actualAmt = Math.min(amt, remaining);
      if (actualAmt < 0.000001) {
        // Skip this offer, try next.
        const subResults = enumerateSplits(hopIdx, offerIdx + 1, remaining, outputSoFar);
        results.push(...subResults);
        continue;
      }
      const x = offers[offerIdx];
      if (actualAmt < x.minimumAmount) continue;
      if (actualAmt > x.maxViable) continue;
      const hopResult = computeHopOutput(actualAmt, {
        feeBps: x.feeBps, rate: x.rate, incentiveBps: x.incentiveBps,
      });
      if (x.dstLiquidity < hopResult.output) continue;
      const subResults = enumerateSplits(hopIdx, offerIdx + 1, remaining - actualAmt, outputSoFar + hopResult.output);
      results.push(...subResults);
    }

    return results;
  }

  // Try each single offer, then split search, with hop backtracking.
  function tryHop(i: number, currentAmount: number): boolean {
    if (i >= path.length) return true;
    const offers = hopInfos[i];
    if (offers.length === 0) return false;

    // Strategy 1: single-offer assignments (backtrack across hops).
    for (let idx = 0; idx < offers.length; idx++) {
      const x = offers[idx];
      if (x.maxViable >= currentAmount && currentAmount >= x.minimumAmount && currentAmount <= x.maximumAmount) {
        const hopResult = computeHopOutput(currentAmount, {
          feeBps: x.feeBps, rate: x.rate, incentiveBps: x.incentiveBps,
        });
        if (x.dstLiquidity >= hopResult.output) {
          if (tryHop(i + 1, hopResult.output)) return true;
        }
      }
    }

    // Strategy 2: downstream-aware split search.
    // (Prompt 4.8.8N) Try ALL possible split outputs, not just the first.
    const splitResults = enumerateSplits(i, 0, currentAmount, 0);
    for (const splitResult of splitResults) {
      if (tryHop(i + 1, splitResult.output)) return true;
    }

    return false;
  }

  return tryHop(0, amount);
}

// (Prompt 4.8.8I) Inventory-feasibility check (liquidity only, no risk).
export function checkInventoryFeasibility(
  path: PathStep<SimOffer>[],
  amount: number,
  world: SimWorld,
): boolean {
  function tryHop(i: number, currentAmount: number): boolean {
    if (i >= path.length) return true;
    const step = path[i];
    const offersWithLiquidity = step.edges
      .map((o) => {
        const prodCap = toProductionCapacity({ availableCapacity: o.availableCapacity, reservedCapacity: o.reservedCapacity });
        const usableCap = prodCap.availableCapacity - prodCap.reservedCapacity;
        const provider = world.providers.get(o.providerId);
        const dstLiquidity = provider?.liquidity?.balances?.get(o.destinationAsset) ?? 0;
        return { offer: o, provider, usableCap, dstLiquidity, minimumAmount: o.minimumAmount };
      })
      .filter((x) => x.provider && x.provider.status === "ACTIVE" && x.usableCap > 0);

    for (const x of offersWithLiquidity) {
      if (x.usableCap >= currentAmount && currentAmount >= x.minimumAmount) {
        const hopResult = computeHopOutput(currentAmount, {
          feeBps: x.offer.feeBps, rate: x.offer.rate, incentiveBps: x.offer.incentiveBps ?? 0,
        });
        if (x.dstLiquidity >= hopResult.output) {
          if (tryHop(i + 1, hopResult.output)) return true;
        }
      }
    }

    // Greedy liquidity-aware split.
    const sorted = [...offersWithLiquidity].sort((a, b) => b.dstLiquidity / (b.usableCap + 1) - a.dstLiquidity / (a.usableCap + 1));
    let remaining = currentAmount;
    let splitOutput = 0;
    for (const x of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, x.usableCap);
      if (take < x.minimumAmount) continue;
      const hopResult = computeHopOutput(take, { feeBps: x.offer.feeBps, rate: x.offer.rate, incentiveBps: x.offer.incentiveBps ?? 0 });
      if (x.dstLiquidity >= hopResult.output) {
        remaining -= take;
        splitOutput += hopResult.output;
      }
    }
    if (remaining <= 0) return tryHop(i + 1, splitOutput);
    return false;
  }
  return tryHop(0, amount);
}

// (Prompt 4.8.8F-M) Staged feasibility check.
export function checkPathFeasibilityStaged(
  path: PathStep<SimOffer>[],
  amount: number,
  riskTolerance: string,
  world: SimWorld,
  saRiskCache: Map<string, number>,
  cpRiskCache: Map<string, number>,
): StagedFeasibility | null {
  let currentAmount = amount;
  let split = false;
  let capacityOK = true;
  let liquidityOK = true;
  let productionOK = true;
  let failureReason: StagedFeasibility["failureReason"] = "none";

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    const coverOffers: CoverOffer[] = step.edges.map((o) => {
      const prodCap = toProductionCapacity({ availableCapacity: o.availableCapacity, reservedCapacity: o.reservedCapacity });
      return {
        id: o.id, channelType: o.channelType, feeBps: o.feeBps,
        availableCapacity: prodCap.availableCapacity, reservedCapacity: prodCap.reservedCapacity,
        minimumAmount: o.minimumAmount,
      };
    });

    const cover = coverAmount(coverOffers, currentAmount);
    if (!cover) {
      // (Prompt 4.8.8N) coverAmount failure means greedy capacity assignment
      // failed. This does NOT mean the path is structurally infeasible —
      // an alternative assignment might succeed. Return a staged result
      // with capacityFeasible=false but still check alternative production.
      return {
        capacityFeasible: false,
        liquidityFeasible: false,
        productionFeasible: false,
        split: false,
        failureReason: "capacity",
        inventoryFeasible: checkInventoryFeasibility(path, amount, world),
        alternativeProductionFeasible: checkAlternativeProductionFeasibility(path, amount, riskTolerance, world, saRiskCache, cpRiskCache),
      };
    }
    if (cover.split) split = true;

    let hopOutputTotal = 0;
    for (const a of cover.assignments) {
      const offer = step.edges.find((e) => e.id === a.offerId);
      if (!offer) return null;
      const provider = world.providers.get(offer.providerId);

      if (!provider) {
        productionOK = false; liquidityOK = false;
        failureReason = "providerMissing";
        return { capacityFeasible: capacityOK, liquidityFeasible: liquidityOK, productionFeasible: productionOK, split, failureReason, inventoryFeasible: false, alternativeProductionFeasible: false };
      }
      if (provider.status !== "ACTIVE") {
        productionOK = false;
        if (failureReason === "none") failureReason = "providerStatus";
      }
      if (a.amount < offer.minimumAmount || a.amount > offer.maximumAmount) {
        productionOK = false;
        if (failureReason === "none") failureReason = "minMax";
      }

      // (4.8.8B) Output-aware liquidity check.
      const hopResult = computeHopOutput(a.amount, {
        feeBps: offer.feeBps, rate: offer.rate, incentiveBps: offer.incentiveBps ?? 0,
      });
      const requiredDstLiquidity = hopResult.output;
      const dstLiquidity = provider.liquidity.balances.get(offer.destinationAsset) ?? 0;
      if (dstLiquidity < requiredDstLiquidity) {
        liquidityOK = false; productionOK = false;
        if (failureReason === "none") failureReason = "liquidity";
      }

      if (offer.settlementAssetId) {
        const saRisk = saRiskCache.get(offer.settlementAssetId);
        if (saRisk !== undefined && saRisk > assetRiskCeiling(riskTolerance)) {
          productionOK = false;
          if (failureReason === "none") failureReason = "risk";
        }
      }
      const cpRisk = cpRiskCache.get(provider.id);
      if (cpRisk !== undefined && cpRisk > counterpartyRiskCeiling(riskTolerance)) {
        productionOK = false;
        if (failureReason === "none") failureReason = "risk";
      }
      hopOutputTotal += hopResult.output;
    }
    currentAmount = hopOutputTotal;
  }

  const inventoryFeasible = liquidityOK ? true : checkInventoryFeasibility(path, amount, world);
  const alternativeProductionFeasible = productionOK ? true : checkAlternativeProductionFeasibility(path, amount, riskTolerance, world, saRiskCache, cpRiskCache);

  return { capacityFeasible: capacityOK, liquidityFeasible: liquidityOK, productionFeasible: productionOK, split, failureReason, inventoryFeasible, alternativeProductionFeasible };
}

// ---- Capacity semantics adapter (Prompt 4.8.8A) ------------------------
//
// CRITICAL: Production and the simulator use DIFFERENT capacity conventions:
//
//   Production (collateral.ts, routing.ts):
//     availableCapacity = TOTAL offer capacity (never changes on reservation)
//     reservedCapacity  = currently reserved portion
//     usable            = availableCapacity - reservedCapacity
//     (reservation: only reservedCapacity is incremented)
//
//   Simulator (engine-faithful.ts, since P4.3):
//     availableCapacity = currently UNRESERVED capacity (decreases on reservation)
//     reservedCapacity  = currently reserved portion (same as production)
//     total             = availableCapacity + reservedCapacity
//     (reservation: availableCapacity -= amount; reservedCapacity += amount)
//
// The shared coverAmount() uses PRODUCTION semantics (usable = available - reserved).
// Feeding a simulator offer directly would DOUBLE-SUBTRACT reservations:
//   simAvailable - simReserved = (total - simReserved) - simReserved = total - 2*reserved
//
// This adapter converts simulator capacity to production capacity:
//   production.availableCapacity = simAvailable + simReserved (= total)
//   production.reservedCapacity  = simReserved (unchanged)
//   → coverAmount computes: total - simReserved = simAvailable ✓
//
// This makes the experiment's capacity check exactly match what the simulator
// itself does when it checks `availableCapacity >= amount` (simulator semantics).

export interface SimulatorCapacity {
  availableCapacity: number; // simulator: currently unreserved
  reservedCapacity: number;  // simulator: currently reserved (same as production)
}

export interface ProductionCapacity {
  availableCapacity: number; // production: total
  reservedCapacity: number;  // production: reserved (same)
}

export function toProductionCapacity(sim: SimulatorCapacity): ProductionCapacity {
  return {
    availableCapacity: sim.availableCapacity + sim.reservedCapacity, // total
    reservedCapacity: sim.reservedCapacity,
  };
}

// Verify the adapter invariant: production.usable == simulator.available.
// production.available - production.reserved == sim.available + sim.reserved - sim.reserved == sim.available
export function productionUsable(prod: ProductionCapacity): number {
  return prod.availableCapacity - prod.reservedCapacity;
}

export function checkPathFeasibility(
  path: PathStep<SimOffer>[],
  amount: number,
  riskTolerance: string,
  world: SimWorld,
  saRiskCache: Map<string, number>,
  cpRiskCache: Map<string, number>,
): PathFeasibility | null {
  let currentAmount = amount;
  let split = false;
  let liqFeasible = true;
  let prodFeasible = true;

  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    // Convert SimOffers to CoverOffers for shared coverAmount.
    // CRITICAL: apply the capacity-semantics adapter (Prompt 4.8.8A).
    // Simulator availableCapacity = unreserved; production availableCapacity = total.
    // Without the adapter, coverAmount would double-subtract reservations.
    const coverOffers: CoverOffer[] = step.edges.map((o) => {
      const prodCap = toProductionCapacity({
        availableCapacity: o.availableCapacity,
        reservedCapacity: o.reservedCapacity,
      });
      return {
        id: o.id,
        channelType: o.channelType,
        feeBps: o.feeBps,
        availableCapacity: prodCap.availableCapacity,
        reservedCapacity: prodCap.reservedCapacity,
        minimumAmount: o.minimumAmount,
      };
    });

    const cover = coverAmount(coverOffers, currentAmount);
    if (!cover) return null; // structural infeasibility: insufficient combined capacity
    if (cover.split) split = true;

    let hopOutputTotal = 0;
    for (const a of cover.assignments) {
      const offer = step.edges.find((e) => e.id === a.offerId);
      if (!offer) return null; // shouldn't happen
      const provider = world.providers.get(offer.providerId);
      // Provider status (production hard filter via buildGraph).
      if (!provider || provider.status !== "ACTIVE") {
        liqFeasible = false; prodFeasible = false; return { liqFeasible, prodFeasible, split };
      }
      // Min/max limits (production checks min in coverAmount; max is an additional
      // feasibility constraint the experiment applies for executability).
      if (a.amount < offer.minimumAmount || a.amount > offer.maximumAmount) {
        liqFeasible = false; prodFeasible = false; return { liqFeasible, prodFeasible, split };
      }
      // Destination liquidity: provider must hold enough of THIS hop's destination asset.
      // (Production checks this at execution time; the experiment checks for feasibility.)
      const hopDstAsset = offer.destinationAsset;
      const dstLiquidity = provider.liquidity.balances.get(hopDstAsset) ?? 0;
      if (dstLiquidity < a.amount) {
        liqFeasible = false; prodFeasible = false; return { liqFeasible, prodFeasible, split };
      }
      // Settlement-asset risk ceiling (production hard filter, per user risk tolerance).
      // Uses cached risk value (precomputed once per extractMetrics call).
      if (offer.settlementAssetId) {
        const saRisk = saRiskCache.get(offer.settlementAssetId);
        if (saRisk !== undefined && saRisk > assetRiskCeiling(riskTolerance)) {
          prodFeasible = false; // liq still OK (risk doesn't affect liquidity feasibility)
        }
      }
      // Counterparty risk ceiling (production hard filter, per user risk tolerance).
      // Uses cached risk value (precomputed once per extractMetrics call).
      const cpRisk = cpRiskCache.get(provider.id);
      if (cpRisk !== undefined && cpRisk > counterpartyRiskCeiling(riskTolerance)) {
        prodFeasible = false;
      }
      // Propagate amount via shared computeHopOutput (canonical hop economics).
      const hopResult = computeHopOutput(a.amount, {
        feeBps: offer.feeBps,
        rate: offer.rate,
        incentiveBps: offer.incentiveBps ?? 0,
      });
      hopOutputTotal += hopResult.output;
    }
    currentAmount = hopOutputTotal;
  }

  return { liqFeasible, prodFeasible, split };
}

// ---- Metrics ----
export interface RunMetrics {
  executionAttemptRate: number;
  // Five-level reachability ladder (each stricter than the last).
  assetReachablePct: number;                    // Abstract asset path (ignores countries)
  corridorReachablePct: number;                 // Asset + country match
  capacityExecutableReachabilityPct: number;    // B: + coverAmount succeeds
  liquidityExecutableReachabilityPct: number;   // C: + dest liquidity (greedy coverAmount, output-aware)
  inventoryExecutableReachabilityPct: number;   // C': SOME assignment has liquidity (ignores risk)
  productionExecutableReachabilityPct: number;  // D: + risk ceilings, min/max, provider status (greedy)
  alternativeProductionExecutableReachabilityPct: number; // D': SOME assignment satisfies ALL constraints
  // Production-faithful route composition (Prompt 4.8.8).
  // Each is the demand-weighted % reachable by that path type. These overlap:
  // a demand may be reachable by multiple path types. totalProdExec ≤ sum of these.
  directReachablePct: number;                   // feasible 1-hop single-provider path
  splitDirectReachablePct: number;              // feasible 1-hop split (multiple providers) path
  twoHopReachablePct: number;                   // feasible 2-hop path
  threePlusHopReachablePct: number;             // feasible 3+-hop path
  assetReachablePairs: number;
  corridorReachablePairs: number;
  totalDemandPairs: number;
  completionRate: number;
  abandonmentRate: number;
  servedCostBps: number;
  effectiveCost100Bps: number;
  effectiveCost300Bps: number;
  effectiveCost500Bps: number;
  p50LatencySteps: number;
  p95LatencySteps: number;
  avgUtilization: number;
  medianNetProfit: number;
  medianNetMargin: number;
  hhi: number;
  routeCompetition: number;
  multiHopPercentage: number;
  totalVolume: number;
  liquidityDepth: number;
  protocolRevenue: number;
  demandServedPct: number;
  corridorsWithMultipleRoutes: number;
}

// Path cache: enumerated paths per corridor, keyed by "source→dest".
// The graph structure (which nodes are connected) doesn't change during a run
// (no providers exit), so paths are enumerated ONCE and reused across all
// extractMetrics calls. Only offer attributes (capacity, liquidity) change.
export type PathCache = Map<string, { hop1: PathStep<SimOffer>[][]; hop2: PathStep<SimOffer>[][]; hop3Plus: PathStep<SimOffer>[][] }>;

export function buildPathCache(world: SimWorld): PathCache {
  const cache: PathCache = new Map();
  const activeOffers = [...world.offers.values()].filter((o: any) => o.active);
  const adj = new Map<string, AdjacencyEdge<SimOffer>[]>();
  for (const o of activeOffers) {
    const provider = world.providers.get(o.providerId);
    if (!provider || provider.status !== "ACTIVE") continue;
    const from = `${o.sourceAsset}:${o.sourceCountry}`;
    const to = `${o.destinationAsset}:${o.destinationCountry}`;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push({ to, edge: o });
  }
  // Enumerate paths for every demand corridor.
  const seenCorridors = new Set<string>();
  for (const u of world.users.values()) {
    const source = `${u.sourceAsset}:${u.sourceCountry}`;
    const dest = `${u.destinationAsset}:${u.destinationCountry}`;
    const key = `${source}→${dest}`;
    if (seenCorridors.has(key)) continue;
    seenCorridors.add(key);
    const allPaths = enumeratePaths(adj, source, dest, MAX_HOPS);
    // Deduplicate by node sequence.
    const seenSeq = new Set<string>();
    const unique: PathStep<SimOffer>[][] = [];
    for (const path of allPaths) {
      const seq = [source, ...path.map(s => s.toNode)].join("→");
      if (seenSeq.has(seq)) continue;
      seenSeq.add(seq);
      unique.push(path);
    }
    unique.sort((a, b) => a.length - b.length);
    const byHop = new Map<number, PathStep<SimOffer>[][]>();
    for (const path of unique) {
      const h = path.length;
      if (!byHop.has(h)) byHop.set(h, []);
      byHop.get(h)!.push(path);
    }
    cache.set(key, {
      hop1: (byHop.get(1) ?? []).slice(0, MAX_PATHS_PER_TIER),
      hop2: (byHop.get(2) ?? []).slice(0, MAX_PATHS_PER_TIER),
      hop3Plus: [...(byHop.get(3) ?? []), ...(byHop.get(4) ?? [])].slice(0, MAX_PATHS_PER_TIER),
    });
  }
  return cache;
}

export function extractMetrics(world: any, mode: "full" | "total" = "full", pathCache?: PathCache): RunMetrics {
  const intents = world.intents;
  const completed = intents.filter((i: any) => i.status === "COMPLETED");
  const abandoned = intents.filter((i: any) => i.status === "ABANDONED");
  const unserved = intents.filter((i: any) => i.status !== "COMPLETED");

  const costs = completed.map((i: any) => i.effectiveCost / i.sourceAmount * 10000);
  const servedCostBps = costs.length > 0 ? costs.reduce((s: number, c: number) => s + c, 0) / costs.length : 0;

  const totalDemandVolume = intents.reduce((s: number, i: any) => s + i.sourceAmount, 0);
  const servedVolume = completed.reduce((s: number, i: any) => s + i.sourceAmount, 0);
  const unservedVolume = totalDemandVolume - servedVolume;

  const calcEffectiveCost = (penaltyBps: number) => {
    const totalCost = completed.reduce((s: number, i: any) => s + i.effectiveCost, 0) + unservedVolume * penaltyBps / 10000;
    return totalDemandVolume > 0 ? totalCost / totalDemandVolume * 10000 : 0;
  };

  const latencies = completed.map((i: any) => i.completedAtStep! - i.createdAtStep).sort((a: number, b: number) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  const activeProviders = [...world.providers.values()].filter((p: any) => p.status === "ACTIVE");
  const stepsPerYear = (365 * 24 * 60) / (world.config.stepDurationMs / 60000);
  const providerEcons = activeProviders.map((p: any) => {
    const elapsedSteps = Math.max(1, world.step - p.entryStep);
    const avgDeployed = p.totalDeployedCapitalSteps / elapsedSteps;
    return calculateProviderEconomics({
      grossFees: p.totalEarnings, incentives: p.totalIncentives, rebates: 0,
      settlementCosts: p.totalVolume * 0.0001, operatingCosts: p.totalVolume * 0.0002,
      capitalCostRate: 0.05, averageDeployedCapital: avgDeployed, expectedLossRate: 0.001,
      penalties: p.totalPenalties, slashing: p.totalSlashing, stepsPerYear,
    });
  });
  const utils = activeProviders.map((p: any) => p.utilization);
  const profits = providerEcons.map((e: any) => e.netEarnings).sort((a: number, b: number) => a - b);
  const margins = providerEcons.filter((e: any) => e.grossEarnings > 0).map((e: any) => (e.netEarnings / e.grossEarnings) * 100).sort((a: number, b: number) => a - b);

  const totalLiquidity = [...world.offers.values()].filter((o: any) => o.active).reduce((s: number, o: any) => s + o.availableCapacity, 0);
  const providerVolumes = activeProviders.map((p: any) => p.totalVolume);
  const totalVol = providerVolumes.reduce((s: number, v: number) => s + v, 0);
  const hhi = totalVol > 0 ? providerVolumes.map((v: number) => (v / totalVol) ** 2).reduce((s: number, h: number) => s + h, 0) : 1;
  const multiHopCount = world.settlementTransfers.filter((t: any) => t.status === "COMPLETED").length;
  const multiHopPercentage = completed.length > 0 ? (multiHopCount / completed.length) * 100 : 0;

  // ---- Five-level reachability ladder (all demand-weighted, consistent) ----
  // 1. ASSET: abstract asset path exists (ignores countries) — graph structure only
  // 2. CORRIDOR: path matches asset AND country — graph structure only
  // 3. LIQUIDITY: + capacity, destination liquidity (per actual demand amount, no risk)
  // 4. PRODUCTION: + risk ceilings (user's ACTUAL riskTolerance), min/max, provider status,
  //    via production-faithful path search (enumeratePaths + coverAmount + computeHopOutput)
  // 5. COMPLETION: actual simulation completion (from intent stats above)
  //
  // Levels 3-4 use shared computeHopOutput/coverAmount/enumeratePaths — the SAME
  // canonical functions production routing.ts uses. No duplicate formula.
  const settlementAssetSymbols = new Set([...world.assets.values()].map((a: any) => a.symbol));
  const activeOffers = [...world.offers.values()].filter((o: any) => o.active);

  // Build adjacency map for production-faithful path enumeration.
  // Only offers from ACTIVE providers form edges (mirrors production buildGraph).
  const adj = new Map<string, AdjacencyEdge<SimOffer>[]>();
  for (const o of activeOffers) {
    const provider = world.providers.get(o.providerId);
    if (!provider || provider.status !== "ACTIVE") continue;
    const from = `${o.sourceAsset}:${o.sourceCountry}`;
    const to = `${o.destinationAsset}:${o.destinationCountry}`;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from)!.push({ to, edge: o });
  }

  // Precompute risk caches (settlement-asset + counterparty risk don't depend
  // on risk tolerance, only on the asset/provider). This avoids recomputing
  // them for every assignment of every path of every demand.
  const saRiskCache = new Map<string, number>();
  for (const [id, sa] of world.assets.entries()) {
    saRiskCache.set(id, settlementAssetRisk({
      assetType: sa.assetType, volatilityScore: sa.volatilityScore,
      liquidityScore: sa.liquidityScore, pegQuality: sa.pegQuality,
      status: sa.status, incentiveRate: sa.incentiveRate,
    }));
  }
  const cpRiskCache = new Map<string, number>();
  for (const [id, p] of world.providers.entries()) {
    cpRiskCache.set(id, providerCounterpartyRisk({
      trustModel: p.trustModel, providerType: p.providerType,
      reputationScore: p.reputationScore, status: p.status,
    }));
  }

  // Collect demand per corridor with per-user risk tolerance.
  interface CorridorDemand { amount: number; weight: number; riskTolerance: string; }
  const demandedCorridors = new Map<string, CorridorDemand[]>();
  for (const u of world.users.values()) {
    const key = `${u.sourceAsset}:${u.sourceCountry}→${u.destinationAsset}:${u.destinationCountry}`;
    const arr = demandedCorridors.get(key) ?? [];
    arr.push({ amount: u.typicalAmount, weight: u.frequency * u.typicalAmount, riskTolerance: u.riskTolerance });
    demandedCorridors.set(key, arr);
  }
  const totalDemandPairs = demandedCorridors.size;
  const totalDemandWeight = [...demandedCorridors.values()].flat().reduce((s, d) => s + d.weight, 0);

  let assetReachablePairs = 0;
  let corridorReachablePairs = 0;
  let liqExecutableReachablePairs = 0;
  let prodExecutableReachablePairs = 0;
  let assetReachableVolume = 0;
  let corridorReachableVolume = 0;
  let capacityExecutableVolume = 0;
  let liqExecutableVolume = 0;
  let inventoryExecutableVolume = 0;
  let prodExecutableVolume = 0;
  let altProductionExecutableVolume = 0;
  let corridorsWithMultipleRoutes = 0;
  // Route-composition weights (Prompt 4.8.8). These overlap: a demand may be
  // reachable by multiple path types. totalProdExec ≤ sum of these.
  let directReachableVolume = 0;        // feasible 1-hop single-provider
  let splitDirectReachableVolume = 0;   // feasible 1-hop split
  let twoHopReachableVolume = 0;        // feasible 2-hop
  let threePlusHopReachableVolume = 0;  // feasible 3+-hop

  for (const [corridorKey, demands] of demandedCorridors) {
    const [srcPart, dstPart] = corridorKey.split("→");
    const [srcAsset, srcCountry] = srcPart.split(":");
    const [dstAsset, dstCountry] = dstPart.split(":");
    const weight = demands.reduce((s, d) => s + d.weight, 0);

    // 1. ASSET reachability (ignores countries) — structural graph check.
    let assetReachable = false;
    let routeCount = 0;
    const directAsset = activeOffers.filter(o => o.sourceAsset === srcAsset && o.destinationAsset === dstAsset);
    if (directAsset.length > 0) { assetReachable = true; routeCount += directAsset.length; }
    for (const sa of settlementAssetSymbols) {
      const hop1 = activeOffers.filter(o => o.sourceAsset === srcAsset && o.destinationAsset === sa);
      const hop2 = activeOffers.filter(o => o.sourceAsset === sa && o.destinationAsset === dstAsset);
      if (hop1.length > 0 && hop2.length > 0) { assetReachable = true; routeCount += Math.min(hop1.length, hop2.length); }
    }
    if (assetReachable) { assetReachablePairs++; assetReachableVolume += weight; }

    // 2. CORRIDOR reachability (matches asset AND country) — structural graph check.
    let corridorReachable = false;
    let corridorRouteCount = 0;
    const directCorridor = activeOffers.filter(o =>
      o.sourceAsset === srcAsset && o.sourceCountry === srcCountry &&
      o.destinationAsset === dstAsset && o.destinationCountry === dstCountry);
    if (directCorridor.length > 0) { corridorReachable = true; corridorRouteCount += directCorridor.length; }
    for (const sa of settlementAssetSymbols) {
      const hop1 = activeOffers.filter(o =>
        o.sourceAsset === srcAsset && o.sourceCountry === srcCountry &&
        o.destinationAsset === sa && o.destinationCountry === "GLOBAL");
      const hop2 = activeOffers.filter(o =>
        o.sourceAsset === sa && o.sourceCountry === "GLOBAL" &&
        o.destinationAsset === dstAsset && o.destinationCountry === dstCountry);
      if (hop1.length > 0 && hop2.length > 0) {
        corridorReachable = true;
        corridorRouteCount += Math.min(hop1.length, hop2.length);
      }
    }
    if (corridorReachable) { corridorReachablePairs++; corridorReachableVolume += weight; }
    if (corridorRouteCount >= 2) corridorsWithMultipleRoutes++;

    // 3+4. Production-faithful path feasibility (Prompt 4.8.8).
    // Use cached paths if available (graph structure doesn't change during a
    // run). Otherwise, enumerate fresh (for standalone/test calls).
    const source = `${srcAsset}:${srcCountry}`;
    const dest = `${dstAsset}:${dstCountry}`;
    const pathKey = `${source}→${dest}`;
    let hop1Paths: PathStep<SimOffer>[][];
    let hop2Paths: PathStep<SimOffer>[][];
    let hop3PlusPaths: PathStep<SimOffer>[][];
    if (pathCache && pathCache.has(pathKey)) {
      const cached = pathCache.get(pathKey)!;
      hop1Paths = cached.hop1;
      hop2Paths = cached.hop2;
      hop3PlusPaths = cached.hop3Plus;
    } else {
      const allPaths = enumeratePaths(adj, source, dest, MAX_HOPS);
      const seenSequences = new Set<string>();
      const uniquePaths: PathStep<SimOffer>[][] = [];
      for (const path of allPaths) {
        const seq = [source, ...path.map(s => s.toNode)].join("→");
        if (seenSequences.has(seq)) continue;
        seenSequences.add(seq);
        uniquePaths.push(path);
      }
      uniquePaths.sort((a, b) => a.length - b.length);
      const pathsByHop = new Map<number, PathStep<SimOffer>[][]>();
      for (const path of uniquePaths) {
        const h = path.length;
        if (!pathsByHop.has(h)) pathsByHop.set(h, []);
        pathsByHop.get(h)!.push(path);
      }
      hop1Paths = (pathsByHop.get(1) ?? []).slice(0, MAX_PATHS_PER_TIER);
      hop2Paths = (pathsByHop.get(2) ?? []).slice(0, MAX_PATHS_PER_TIER);
      hop3PlusPaths = [...(pathsByHop.get(3) ?? []), ...(pathsByHop.get(4) ?? [])].slice(0, MAX_PATHS_PER_TIER);
    }

    // Pre-filter: compute the max destination-asset liquidity across all active
    // providers. If a demand's amount exceeds this, no direct route can pay out
    // (the provider needs dstLiquidity ≥ amount). This eliminates obviously
    // infeasible demands without checking any paths.
    let maxDstLiquidity = 0;
    for (const p of world.providers.values()) {
      if (p.status !== "ACTIVE") continue;
      const liq = p.liquidity.balances.get(dstAsset) ?? 0;
      if (liq > maxDstLiquidity) maxDstLiquidity = liq;
    }

    let capacityExecutableWeight = 0;
    let liqExecutableWeight = 0;
    let inventoryExecutableWeight = 0;
    let prodExecutableWeight = 0;
    let altProductionExecutableWeight = 0;
    let directWeight = 0;
    let splitDirectWeight = 0;
    let twoHopWeight = 0;
    let threePlusHopWeight = 0;
    const needBreakdown = mode === "full";
    const maxSample = needBreakdown ? MAX_DEMANDS_FULL : MAX_DEMANDS_TOTAL;

    // Demand sampling: if the corridor has more demands than maxSample, pick
    // evenly-spaced samples by amount. Each sample's weight is scaled to
    // represent its share of the corridor's total demand weight.
    let sampledDemands: { amount: number; weight: number; riskTolerance: string }[];
    if (demands.length <= maxSample) {
      sampledDemands = demands;
    } else {
      // Sort by amount and pick evenly-spaced samples.
      const sorted = [...demands].sort((a, b) => a.amount - b.amount);
      const totalWeight = sorted.reduce((s, d) => s + d.weight, 0);
      const perSampleWeight = totalWeight / maxSample;
      sampledDemands = [];
      for (let i = 0; i < maxSample; i++) {
        const idx = Math.floor((i + 0.5) * sorted.length / maxSample);
        sampledDemands.push({
          amount: sorted[idx].amount,
          weight: perSampleWeight,
          riskTolerance: sorted[idx].riskTolerance,
        });
      }
    }

    for (const demand of sampledDemands) {
      const amt = demand.amount;
      const rt = demand.riskTolerance;
      let capOK = false;
      let liqOK = false;
      let invOK = false;
      let prodOK = false;
      let altProdOK = false;
      let hasDirect = false;
      let hasSplitDirect = false;
      let hasTwoHop = false;
      let hasThreePlusHop = false;

      if (amt > maxDstLiquidity) continue;

      // Tier 1: 1-hop paths (direct).
      for (const path of hop1Paths) {
        const staged = checkPathFeasibilityStaged(path, amt, rt, world, saRiskCache, cpRiskCache);
        if (!staged) continue;
        if (staged.capacityFeasible) capOK = true;
        if (staged.liquidityFeasible) liqOK = true;
        if (staged.inventoryFeasible) invOK = true;
        if (staged.productionFeasible) {
          prodOK = true;
          if (needBreakdown) {
            if (staged.split) hasSplitDirect = true;
            else hasDirect = true;
          }
        }
        if (staged.alternativeProductionFeasible) altProdOK = true;
        if (!needBreakdown && prodOK && altProdOK) break;
        if (needBreakdown && hasDirect && hasSplitDirect) break;
      }

      // Tier 2: 2-hop paths.
      if (needBreakdown || !prodOK || !altProdOK) {
        for (const path of hop2Paths) {
          const staged = checkPathFeasibilityStaged(path, amt, rt, world, saRiskCache, cpRiskCache);
          if (!staged) continue;
          if (staged.capacityFeasible) capOK = true;
          if (staged.liquidityFeasible) liqOK = true;
          if (staged.inventoryFeasible) invOK = true;
          if (staged.productionFeasible) {
            prodOK = true;
            if (needBreakdown) hasTwoHop = true;
          }
          if (staged.alternativeProductionFeasible) altProdOK = true;
          if (!needBreakdown && prodOK && altProdOK) break;
          if (needBreakdown && hasTwoHop) break;
        }
      }

      // Tier 3+4: 3-hop and 4-hop paths.
      if (needBreakdown || !prodOK || !altProdOK) {
        for (const path of hop3PlusPaths) {
          const staged = checkPathFeasibilityStaged(path, amt, rt, world, saRiskCache, cpRiskCache);
          if (!staged) continue;
          if (staged.capacityFeasible) capOK = true;
          if (staged.liquidityFeasible) liqOK = true;
          if (staged.inventoryFeasible) invOK = true;
          if (staged.productionFeasible) {
            prodOK = true;
            if (needBreakdown) hasThreePlusHop = true;
          }
          if (staged.alternativeProductionFeasible) altProdOK = true;
          if (!needBreakdown && prodOK && altProdOK) break;
          if (needBreakdown && hasThreePlusHop) break;
        }
      }

      if (capOK) capacityExecutableWeight += demand.weight;
      if (liqOK) liqExecutableWeight += demand.weight;
      if (invOK) inventoryExecutableWeight += demand.weight;
      if (prodOK) {
        prodExecutableWeight += demand.weight;
        if (hasDirect) directWeight += demand.weight;
        if (hasSplitDirect) splitDirectWeight += demand.weight;
        if (hasTwoHop) twoHopWeight += demand.weight;
        if (hasThreePlusHop) threePlusHopWeight += demand.weight;
      }
      if (altProdOK) altProductionExecutableWeight += demand.weight;
    }

    // Amount-weighted reachability for this corridor.
    if (capacityExecutableWeight > 0) capacityExecutableVolume += capacityExecutableWeight;
    if (liqExecutableWeight > 0) { liqExecutableReachablePairs++; liqExecutableVolume += liqExecutableWeight; }
    if (inventoryExecutableWeight > 0) inventoryExecutableVolume += inventoryExecutableWeight;
    if (prodExecutableWeight > 0) { prodExecutableReachablePairs++; prodExecutableVolume += prodExecutableWeight; }
    if (altProductionExecutableWeight > 0) altProductionExecutableVolume += altProductionExecutableWeight;
    directReachableVolume += directWeight;
    splitDirectReachableVolume += splitDirectWeight;
    twoHopReachableVolume += twoHopWeight;
    threePlusHopReachableVolume += threePlusHopWeight;
  }

  const assetReachablePct = totalDemandWeight > 0 ? (assetReachableVolume / totalDemandWeight) * 100 : 0;
  const corridorReachablePct = totalDemandWeight > 0 ? (corridorReachableVolume / totalDemandWeight) * 100 : 0;
  const capExecutablePct = totalDemandWeight > 0 ? (capacityExecutableVolume / totalDemandWeight) * 100 : 0;
  const liqExecutablePct = totalDemandWeight > 0 ? (liqExecutableVolume / totalDemandWeight) * 100 : 0;
  const invExecutablePct = totalDemandWeight > 0 ? (inventoryExecutableVolume / totalDemandWeight) * 100 : 0;
  const prodExecutablePct = totalDemandWeight > 0 ? (prodExecutableVolume / totalDemandWeight) * 100 : 0;
  const altProdExecutablePct = totalDemandWeight > 0 ? (altProductionExecutableVolume / totalDemandWeight) * 100 : 0;
  const directPct = totalDemandWeight > 0 ? (directReachableVolume / totalDemandWeight) * 100 : 0;
  const splitDirectPct = totalDemandWeight > 0 ? (splitDirectReachableVolume / totalDemandWeight) * 100 : 0;
  const twoHopPct = totalDemandWeight > 0 ? (twoHopReachableVolume / totalDemandWeight) * 100 : 0;
  const threePlusHopPct = totalDemandWeight > 0 ? (threePlusHopReachableVolume / totalDemandWeight) * 100 : 0;

  const corridorOfferCounts = new Map<string, number>();
  for (const o of world.offers.values()) {
    if (!o.active) continue;
    const key = `${o.sourceAsset}→${o.destinationAsset}`;
    corridorOfferCounts.set(key, (corridorOfferCounts.get(key) ?? 0) + 1);
  }
  const routeCompetition = corridorOfferCounts.size > 0
    ? [...corridorOfferCounts.values()].reduce((s, c) => s + c, 0) / corridorOfferCounts.size : 0;

  const median = (arr: number[]) => arr.length > 0 ? arr[Math.floor(arr.length / 2)] : 0;

  return {
    executionAttemptRate: intents.length > 0 ? (intents.filter((i: any) => i.status === "COMPLETED" || i.status === "EXECUTING" || i.status === "FAILED").length / intents.length) * 100 : 0,
    assetReachablePct: Math.round(assetReachablePct * 100) / 100,
    corridorReachablePct: Math.round(corridorReachablePct * 100) / 100,
    capacityExecutableReachabilityPct: Math.round(capExecutablePct * 100) / 100,
    liquidityExecutableReachabilityPct: Math.round(liqExecutablePct * 100) / 100,
    inventoryExecutableReachabilityPct: Math.round(invExecutablePct * 100) / 100,
    productionExecutableReachabilityPct: Math.round(prodExecutablePct * 100) / 100,
    alternativeProductionExecutableReachabilityPct: Math.round(altProdExecutablePct * 100) / 100,
    directReachablePct: Math.round(directPct * 100) / 100,
    splitDirectReachablePct: Math.round(splitDirectPct * 100) / 100,
    twoHopReachablePct: Math.round(twoHopPct * 100) / 100,
    threePlusHopReachablePct: Math.round(threePlusHopPct * 100) / 100,
    assetReachablePairs,
    corridorReachablePairs,
    totalDemandPairs,
    completionRate: intents.length > 0 ? (completed.length / intents.length) * 100 : 0,
    abandonmentRate: intents.length > 0 ? (abandoned.length / intents.length) * 100 : 0,
    servedCostBps: Math.round(servedCostBps * 100) / 100,
    effectiveCost100Bps: Math.round(calcEffectiveCost(100) * 100) / 100,
    effectiveCost300Bps: Math.round(calcEffectiveCost(300) * 100) / 100,
    effectiveCost500Bps: Math.round(calcEffectiveCost(500) * 100) / 100,
    p50LatencySteps: p50,
    p95LatencySteps: p95,
    avgUtilization: utils.length > 0 ? Math.round((utils.reduce((s: number, u: number) => s + u, 0) / utils.length) * 10000) / 100 : 0,
    medianNetProfit: Math.round(median(profits) * 100) / 100,
    medianNetMargin: Math.round(median(margins) * 100) / 100,
    hhi: Math.round(hhi * 10000) / 10000,
    routeCompetition: Math.round(routeCompetition * 100) / 100,
    multiHopPercentage: Math.round(multiHopPercentage * 100) / 100,
    totalVolume: Math.round(totalVol * 100) / 100,
    liquidityDepth: Math.round(totalLiquidity * 100) / 100,
    protocolRevenue: Math.round(world.totalFees * 100) / 100,
    demandServedPct: totalDemandVolume > 0 ? Math.round((servedVolume / totalDemandVolume) * 10000) / 100 : 0,
    corridorsWithMultipleRoutes,
  };
}

// ---- Stats ----
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
}
function statsLabel(arr: number[]): string {
  return `${percentile(arr, 0.5).toFixed(1)} (${percentile(arr, 0.1).toFixed(1)}–${percentile(arr, 0.9).toFixed(1)})`;
}

// ---- Experiment ----
const PROVIDER_COUNTS = [5, 10, 20, 50, 100];
const TOPOLOGIES: TopologyMode[] = ["RANDOM", "CORRIDOR_FOCUSED", "BRIDGED"];
const NUM_SEEDS = 20;
const BASE_SEED = 10000;

function makeConfig(seed: number): SimConfig {
  return {
    ...createDefaultConfig(),
    seed, totalSteps: 100, stepDurationMs: 60000,
    initialProviders: 0, providerGrowthRate: 0.0, providerExitThreshold: -999,
    demandVolume: 10, demandGrowth: 0.0,
    enableIncentives: false, shockType: null, shockStep: 999, shockMagnitude: 0,
    enableLiquidityInventory: true, enableStochasticSettlement: true,
    enableDemandPatience: true, defaultMaxAcceptablePriceBps: 400,
    defaultMaxAcceptableLatencySteps: 30, liquidityReplenishSteps: 10,
  };
}

function runExperiment() {
  console.log("Running topology experiment (P4.8.8 — production-faithful path reachability)...");
  console.log(`  ${PROVIDER_COUNTS.length} densities × ${TOPOLOGIES.length} topologies × ${NUM_SEEDS} seeds = ${PROVIDER_COUNTS.length * TOPOLOGIES.length * NUM_SEEDS} runs`);

  interface Result { density: number; topology: string; metrics: RunMetrics[] }
  const results: Result[] = [];

  const settlementAssets = new Map<string, SimSettlementAsset>([
    ["asset_usdc", { id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_eurc", { id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_sc", { id: "asset_sc", symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT", volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0, incentiveRate: 0, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_weth", { id: "asset_weth", symbol: "WETH", assetType: "VOLATILE_TOKEN", volatilityScore: 0.6, liquidityScore: 0.6, pegQuality: null, incentiveRate: 0, collateralHaircut: 0.5, isEligibleCollateral: false, status: "ACTIVE" }],
  ]);

  for (const topology of TOPOLOGIES) {
    for (const density of PROVIDER_COUNTS) {
      const metrics: RunMetrics[] = [];
      for (let s = 0; s < NUM_SEEDS; s++) {
        const seed = BASE_SEED + s;
        const config = makeConfig(seed);

        // Per-seed: frozen demand + derived corridors + canonical pool.
        const demandPopulation = generateDemandPopulation(seed, 50, config);
        const demandCorridors = deriveDemandCorridors(demandPopulation);
        const canonicalSpecs = generateCanonicalSpecs(seed + 99999, 100, topology, settlementAssets, demandCorridors);

        // Build world with deep-cloned providers (fresh state per run).
        const world = buildWorld(seed, density, topology, demandPopulation, canonicalSpecs, config);

        // Build path cache ONCE per run: enumerate all paths for all corridors.
        // The graph structure doesn't change during the run (no providers exit),
        // so paths are reused across all extractMetrics calls. Only offer
        // attributes (capacity, liquidity) change, which affect feasibility
        // but not path existence.
        const pCache = buildPathCache(world);

        // Capture INITIAL reachability (full breakdown — before simulation).
        const initialMetrics = extractMetrics(world, "full", pCache);

        // Run simulation, capturing reachability every 25 steps.
        // Time-series uses "total" mode (only production-executable %, with early
        // termination) for performance. The depletion curve only needs the total.
        const rng = new SeededRNG(seed);
        const timeSeriesMetrics: RunMetrics[] = [initialMetrics];
        for (let step = 0; step < config.totalSteps; step++) {
          simulateStep(world, rng);
          if ((step + 1) % 25 === 0 || step === config.totalSteps - 1) {
            timeSeriesMetrics.push(extractMetrics(world, "total", pCache));
          }
        }

        // Final metrics (full breakdown) + time-series summary.
        const finalMetrics = extractMetrics(world, "full", pCache);
        // Add time-series fields to finalMetrics.
        const tsAsset = timeSeriesMetrics.map(m => m.assetReachablePct);
        const tsCorridor = timeSeriesMetrics.map(m => m.corridorReachablePct);
        const tsLiqExec = timeSeriesMetrics.map(m => m.liquidityExecutableReachabilityPct);
        const tsProdExec = timeSeriesMetrics.map(m => m.productionExecutableReachabilityPct);
        (finalMetrics as any).initialAssetReach = tsAsset[0];
        (finalMetrics as any).initialCorridorReach = tsCorridor[0];
        (finalMetrics as any).initialProdExecReach = tsProdExec[0];
        (finalMetrics as any).meanProdExecReach = tsProdExec.reduce((s, v) => s + v, 0) / tsProdExec.length;
        (finalMetrics as any).p10ProdExecReach = percentile(tsProdExec, 0.1);
        (finalMetrics as any).p50ProdExecReach = percentile(tsProdExec, 0.5);
        (finalMetrics as any).p90ProdExecReach = percentile(tsProdExec, 0.9);
        (finalMetrics as any).finalProdExecReach = tsProdExec[tsProdExec.length - 1];
        (finalMetrics as any).depletionPct = tsProdExec[0] > 0 ? ((tsProdExec[0] - tsProdExec[tsProdExec.length - 1]) / tsProdExec[0]) * 100 : 0;

        metrics.push(finalMetrics);
      }
      results.push({ density, topology, metrics });
      process.stderr.write(`  Done: ${density} providers / ${topology} (${NUM_SEEDS} seeds)\n`);
    }
  }
  return results;
}

function printResults(results: Result[]) {
  console.log("\n╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║  dRamp Topology Experiment (P4.8.8 — Production-Faithful Path Reach)  ║");
  console.log("║  20 seeds | 100 steps | Per-seed canonical pool | Deep clone         ║");
  console.log("║  Controls: no entry/exit, no incentives, no shocks                    ║");
  console.log("║  Routing: shared computeHopOutput/coverAmount/enumeratePaths (maxHops=4) ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝");

  // Table A: Five-level reachability ladder
  console.log("\n### Table A — Reachable Demand % (Asset / Corridor / Liq-Exec / Prod-Exec)\n");
  console.log("| Providers | Topology | Asset % | Corridor % | Liq-exec % | Prod-exec % |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const ar = r.metrics.map(m => m.assetReachablePct);
    const cr = r.metrics.map(m => m.corridorReachablePct);
    const lr = r.metrics.map(m => m.liquidityExecutableReachabilityPct);
    const pr = r.metrics.map(m => m.productionExecutableReachabilityPct);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(ar)} | ${statsLabel(cr)} | ${statsLabel(lr)} | ${statsLabel(pr)} |`);
  }

  // Table A2: Route composition (direct / split / 2-hop / 3+hop) — production-faithful
  console.log("\n### Table A2 — Route Composition % (Production-Faithful Path Search, maxHops=4)\n");
  console.log("| Providers | Topology | Direct (single) % | Split direct % | 2-hop % | 3+-hop % |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const d = r.metrics.map(m => m.directReachablePct);
    const sd = r.metrics.map(m => m.splitDirectReachablePct);
    const th = r.metrics.map(m => m.twoHopReachablePct);
    const tph = r.metrics.map(m => m.threePlusHopReachablePct);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(d)} | ${statsLabel(sd)} | ${statsLabel(th)} | ${statsLabel(tph)} |`);
  }

  // Table B: Completion / Effective cost sensitivity
  console.log("\n### Table B — Completion % / Effective Cost Sensitivity\n");
  console.log("| Providers | Topology | Completion % | Eff cost 100bps | Eff cost 300bps | Eff cost 500bps |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const comp = r.metrics.map(m => m.completionRate);
    const ec100 = r.metrics.map(m => m.effectiveCost100Bps);
    const ec300 = r.metrics.map(m => m.effectiveCost300Bps);
    const ec500 = r.metrics.map(m => m.effectiveCost500Bps);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(comp)} | ${statsLabel(ec100)} | ${statsLabel(ec300)} | ${statsLabel(ec500)} |`);
  }

  // Table C: Provider economics
  console.log("\n### Table C — Provider Economics\n");
  console.log("| Providers | Topology | Avg util % | Median profit $ | Multi-hop % |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const au = r.metrics.map(m => m.avgUtilization);
    const mp = r.metrics.map(m => m.medianNetProfit);
    const mh = r.metrics.map(m => m.multiHopPercentage);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(au)} | ${statsLabel(mp)} | ${statsLabel(mh)} |`);
  }

  // Table D: Graph connectivity (corridor-level)
  console.log("\n### Table D — Graph Connectivity (Corridor-Level)\n");
  console.log("| Providers | Topology | Corridor reachable pairs | Total demand pairs | Multiple routes |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const rp = r.metrics.map(m => m.corridorReachablePairs);
    const tp = r.metrics.map(m => m.totalDemandPairs);
    const mr = r.metrics.map(m => m.corridorsWithMultipleRoutes);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(rp)} | ${statsLabel(tp)} | ${statsLabel(mr)} |`);
  }

  // Conclusion: Production routing opportunity
  console.log("\n### Conclusion: Production Routing Opportunity (P4.8.8N)\n");
  for (const topo of TOPOLOGIES) {
    const r100 = results.find(r => r.density === 100 && r.topology === topo);
    if (r100) {
      const medCorridor = percentile(r100.metrics.map(m => m.corridorReachablePct), 0.5);
      const medCap = percentile(r100.metrics.map(m => m.capacityExecutableReachabilityPct), 0.5);
      const medLiq = percentile(r100.metrics.map(m => m.liquidityExecutableReachabilityPct), 0.5);
      const medInv = percentile(r100.metrics.map(m => m.inventoryExecutableReachabilityPct), 0.5);
      const medProd = percentile(r100.metrics.map(m => m.productionExecutableReachabilityPct), 0.5);
      const medAltProd = percentile(r100.metrics.map(m => m.alternativeProductionExecutableReachabilityPct), 0.5);
      const medComp = percentile(r100.metrics.map(m => m.completionRate), 0.5);
      const medMultiHop = percentile(r100.metrics.map(m => m.multiHopPercentage), 0.5);

      const liquidityAvailabilityGain = medInv - medLiq;
      const productionRoutingGain = medAltProd - medProd;

      console.log(`  ${topo} @ 100:`);
      console.log(`    Reachability ladder (demand-weighted %):`);
      console.log(`      A. Structural (4-hop graph):    ${medCorridor.toFixed(1)}%`);
      console.log(`      B. + Capacity:                  ${medCap.toFixed(1)}%`);
      console.log(`      C. + Greedy liquidity:          ${medLiq.toFixed(1)}%`);
      console.log(`      C'. + Inventory-feasible:       ${medInv.toFixed(1)}%  (SOME assignment has liquidity)`);
      console.log(`      D. + Greedy production:         ${medProd.toFixed(1)}%  (greedy coverAmount + risk)`);
      console.log(`      D'. + Alternative production:   ${medAltProd.toFixed(1)}%  (SOME assignment satisfies ALL constraints)`);
      console.log(`    Gains from inventory-aware routing:`);
      console.log(`      Liquidity availability gain (C→C'):  ${liquidityAvailabilityGain.toFixed(1)} pp  (more demand has SOME liquidity)`);
      console.log(`      Production routing gain (D→D'):      ${productionRoutingGain.toFixed(1)} pp  (more demand is production-executable)`);
      console.log(`      NOTE: Only the production routing gain is addressable by changing the router.`);
      console.log(`    Realized execution (separate population — NOT subtracted from D):`);
      console.log(`      Completion rate:               ${medComp.toFixed(1)}%`);
      console.log(`      Multi-hop share of completions: ${medMultiHop.toFixed(1)}%`);
    }
  }
}

// Run only when executed directly (not when imported by tests).
// This prevents the 300-run experiment from executing on import.
import { pathToFileURL } from "node:url";
const __isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (__isMain) {
  const results = runExperiment();
  printResults(results);
  console.log("\nExperiment complete.");
}
