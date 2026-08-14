// dRamp Prompt 4.8.3 — Independent Replicates & True Reachability
//
// Fixes:
//   1. Immutable provider spec + deep clone per run (no mutable reuse)
//   2. Per-seed canonical pool (derive corridors from each seed's demand)
//   3. Correct route coverage semantics (executionAttemptRate vs reachableDemandPct)
//   4. Separate graph reachability from executable reachability
//   5. Effective-cost sensitivity (100/300/500 bps)
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
import { calculateProviderEconomics, settlementAssetRisk, assetRiskCeiling, counterpartyRiskCeiling, providerCounterpartyRisk } from "../src/lib/economics/shared";

// ---- Constants ----
const COUNTRIES = ["US", "EU", "NG", "PH", "KE", "GB", "SG", "JP", "IN", "BR"];
const ASSETS = ["USD", "EUR", "NGN", "PHP", "KES", "GBP", "SGD", "JPY", "INR", "BRL"];
const PROVIDER_TYPES = ["LOCAL_FIAT_AGENT", "PSP", "BANK", "CEX", "DEX", "STABLECOIN_LP", "MARKET_MAKER", "TREASURY"];
const TRUST_MODELS = ["COLLATERALIZED", "INSTITUTIONALLY_TRUSTED", "PRE_FUNDED", "NON_CUSTODIAL"];
const STRATEGIES = ["AGGRESSIVE", "PREMIUM", "LIQUIDITY_MAXIMIZER", "MARKET_MAKER", "INCENTIVE_SEEKER", "CONSERVATIVE", "OPPORTUNISTIC"];
const PROVIDER_NAMES = ["Northbridge", "SwiftPay", "Meridian", "Atlas", "OpenSwap", "Sahara", "Continental", "Pacific", "GlobalBridge", "TransContinental", "FastCorridor", "LiquidityHub", "CapitalFlow", "EdgeExchange", "DirectRoute", "PrimeLiquidity", "ValueBridge", "SpeedTransfer", "TrustFlow", "OpenMarket"];

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
function buildWorld(
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

// ---- Metrics ----
interface RunMetrics {
  executionAttemptRate: number;
  // Four reachability levels (each stricter than the last).
  assetReachablePct: number;                    // Abstract asset path (ignores countries)
  corridorReachablePct: number;                 // Asset + country match
  liquidityExecutableReachabilityPct: number;   // + capacity ≥100, dest liquidity ≥100
  productionExecutableReachabilityPct: number;  // + risk ceilings, min/max, provider status
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

function extractMetrics(world: any): RunMetrics {
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

  // ---- Three-level reachability ----
  // 1. ASSET reachability: does an abstract asset path exist? (ignores countries)
  // 2. CORRIDOR reachability: does a path exist matching asset AND country?
  // 3. EXECUTABLE reachability: does a path exist with capacity, liquidity, risk?
  const settlementAssetSymbols = new Set([...world.assets.values()].map((a: any) => a.symbol));
  const activeOffers = [...world.offers.values()].filter((o: any) => o.active);

  // Demanded corridors: (srcAsset, srcCountry) → (dstAsset, dstCountry)
  const demandedCorridors = new Map<string, number>(); // key → demand weight
  for (const u of world.users.values()) {
    const key = `${u.sourceAsset}:${u.sourceCountry}→${u.destinationAsset}:${u.destinationCountry}`;
    demandedCorridors.set(key, (demandedCorridors.get(key) ?? 0) + u.typicalAmount * u.frequency);
  }
  const totalDemandPairs = demandedCorridors.size;
  const totalDemandWeight = [...demandedCorridors.values()].reduce((s, v) => s + v, 0);

  let assetReachablePairs = 0;
  let corridorReachablePairs = 0;
  let liqExecutableReachablePairs = 0;
  let prodExecutableReachablePairs = 0;
  let assetReachableVolume = 0;
  let corridorReachableVolume = 0;
  let liqExecutableVolume = 0;
  let prodExecutableVolume = 0;
  let corridorsWithMultipleRoutes = 0;

  for (const [corridorKey, weight] of demandedCorridors) {
    const [srcPart, dstPart] = corridorKey.split("→");
    const [srcAsset, srcCountry] = srcPart.split(":");
    const [dstAsset, dstCountry] = dstPart.split(":");

    // 1. ASSET reachability (ignores countries).
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

    // 2. CORRIDOR reachability (matches asset AND country).
    let corridorReachable = false;
    let corridorRouteCount = 0;
    const directCorridor = activeOffers.filter(o =>
      o.sourceAsset === srcAsset && o.sourceCountry === srcCountry &&
      o.destinationAsset === dstAsset && o.destinationCountry === dstCountry);
    if (directCorridor.length > 0) { corridorReachable = true; corridorRouteCount += directCorridor.length; }
    // Multi-hop: src/fiat → settlement/GLOBAL → dst/fiat
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

    // 3. LIQUIDITY-EXECUTABLE reachability (capacity + destination liquidity, all hops).
    // Checks: active offer, availableCapacity ≥ 100, destination liquidity ≥ 100.
    // For multi-hop: checks BOTH hops' capacity and BOTH providers' destination liquidity.
    let liqExecutable = false;
    // Direct.
    for (const o of directCorridor) {
      if (o.availableCapacity >= 100) {
        const provider = world.providers.get(o.providerId);
        if (provider && (provider.liquidity.balances.get(dstAsset) ?? 0) >= 100) {
          liqExecutable = true; break;
        }
      }
    }
    // Multi-hop: check BOTH hops.
    if (!liqExecutable) {
      for (const sa of settlementAssetSymbols) {
        const hop1 = activeOffers.filter(o =>
          o.sourceAsset === srcAsset && o.sourceCountry === srcCountry &&
          o.destinationAsset === sa && o.destinationCountry === "GLOBAL" && o.availableCapacity >= 100);
        const hop2 = activeOffers.filter(o =>
          o.sourceAsset === sa && o.sourceCountry === "GLOBAL" &&
          o.destinationAsset === dstAsset && o.destinationCountry === dstCountry && o.availableCapacity >= 100);
        if (hop1.length > 0 && hop2.length > 0) {
          // Check liquidity for BOTH hops' providers.
          for (const o1 of hop1) {
            const p1 = world.providers.get(o1.providerId);
            if (!p1 || (p1.liquidity.balances.get(sa) ?? 0) < 100) continue;
            for (const o2 of hop2) {
              const p2 = world.providers.get(o2.providerId);
              if (p2 && (p2.liquidity.balances.get(dstAsset) ?? 0) >= 100) {
                liqExecutable = true; break;
              }
            }
            if (liqExecutable) break;
          }
          if (liqExecutable) break;
        }
      }
    }
    if (liqExecutable) { liqExecutableReachablePairs++; liqExecutableVolume += weight; }

    // 4. PRODUCTION-EXECUTABLE reachability (demand-weighted, full hard constraints).
    // For each corridor, test against the ACTUAL demand amounts from users in that corridor.
    // Uses shared pure economics functions for risk ceilings.
    // Returns amount-weighted executable demand %.
    // Collect actual demand amounts for this corridor.
    const corridorDemandAmounts: Array<{ amount: number; weight: number }> = [];
    for (const u of world.users.values()) {
      if (u.sourceAsset === srcAsset && u.sourceCountry === srcCountry &&
          u.destinationAsset === dstAsset && u.destinationCountry === dstCountry) {
        corridorDemandAmounts.push({ amount: u.typicalAmount, weight: u.frequency * u.typicalAmount });
      }
    }
    const corridorDemandTotal = corridorDemandAmounts.reduce((s, d) => s + d.weight, 0);
    let corridorDemandExecutable = 0;

    for (const demand of corridorDemandAmounts) {
      const amt = demand.amount;
      let canExecute = false;
      // Direct.
      for (const o of directCorridor) {
        const provider = world.providers.get(o.providerId);
        if (!provider || provider.status !== "ACTIVE") continue;
        if (o.availableCapacity < amt) continue;
        if (amt < o.minimumAmount || amt > o.maximumAmount) continue;
        if ((provider.liquidity.balances.get(dstAsset) ?? 0) < amt) continue;
        if (o.settlementAssetId) {
          const saObj = world.assets.get(o.settlementAssetId);
          if (saObj) {
            const saRisk = settlementAssetRisk({ assetType: saObj.assetType, volatilityScore: saObj.volatilityScore, liquidityScore: saObj.liquidityScore, pegQuality: saObj.pegQuality, status: saObj.status, incentiveRate: saObj.incentiveRate });
            if (saRisk > assetRiskCeiling("BALANCED")) continue;
          }
        }
        const cpRisk = providerCounterpartyRisk({ trustModel: provider.trustModel, providerType: provider.providerType, reputationScore: provider.reputationScore, status: provider.status });
        if (cpRisk > counterpartyRiskCeiling("BALANCED")) continue;
        canExecute = true; break;
      }
      // Multi-hop.
      if (!canExecute) {
        for (const sa of settlementAssetSymbols) {
          const hop1 = activeOffers.filter(o => o.sourceAsset === srcAsset && o.sourceCountry === srcCountry && o.destinationAsset === sa && o.destinationCountry === "GLOBAL");
          const hop2 = activeOffers.filter(o => o.sourceAsset === sa && o.sourceCountry === "GLOBAL" && o.destinationAsset === dstAsset && o.destinationCountry === dstCountry);
          if (hop1.length === 0 || hop2.length === 0) continue;
          const saObj = [...world.assets.values()].find((a: any) => a.symbol === sa);
          if (saObj) {
            const saRisk = settlementAssetRisk({ assetType: saObj.assetType, volatilityScore: saObj.volatilityScore, liquidityScore: saObj.liquidityScore, pegQuality: saObj.pegQuality, status: saObj.status, incentiveRate: saObj.incentiveRate });
            if (saRisk > assetRiskCeiling("BALANCED")) continue;
          }
          for (const o1 of hop1) {
            const p1 = world.providers.get(o1.providerId);
            if (!p1 || p1.status !== "ACTIVE") continue;
            if (o1.availableCapacity < amt) continue;
            if (amt < o1.minimumAmount || amt > o1.maximumAmount) continue;
            if ((p1.liquidity.balances.get(sa) ?? 0) < amt) continue;
            const cpRisk1 = providerCounterpartyRisk({ trustModel: p1.trustModel, providerType: p1.providerType, reputationScore: p1.reputationScore, status: p1.status });
            if (cpRisk1 > counterpartyRiskCeiling("BALANCED")) continue;
            for (const o2 of hop2) {
              const p2 = world.providers.get(o2.providerId);
              if (!p2 || p2.status !== "ACTIVE") continue;
              if (o2.availableCapacity < amt) continue;
              if (amt < o2.minimumAmount || amt > o2.maximumAmount) continue;
              if ((p2.liquidity.balances.get(dstAsset) ?? 0) < amt) continue;
              const cpRisk2 = providerCounterpartyRisk({ trustModel: p2.trustModel, providerType: p2.providerType, reputationScore: p2.reputationScore, status: p2.status });
              if (cpRisk2 > counterpartyRiskCeiling("BALANCED")) continue;
              canExecute = true; break;
            }
            if (canExecute) break;
          }
          if (canExecute) break;
        }
      }
      if (canExecute) corridorDemandExecutable += demand.weight;
    }
    // Amount-weighted executable demand for this corridor.
    if (corridorDemandTotal > 0 && corridorDemandExecutable > 0) {
      prodExecutableReachablePairs++;
      prodExecutableVolume += (corridorDemandExecutable / corridorDemandTotal) * weight;
    }
  }

  const assetReachablePct = totalDemandWeight > 0 ? (assetReachableVolume / totalDemandWeight) * 100 : 0;
  const corridorReachablePct = totalDemandWeight > 0 ? (corridorReachableVolume / totalDemandWeight) * 100 : 0;
  const liqExecutablePct = totalDemandWeight > 0 ? (liqExecutableVolume / totalDemandWeight) * 100 : 0;
  const prodExecutablePct = totalDemandWeight > 0 ? (prodExecutableVolume / totalDemandWeight) * 100 : 0;

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
    liquidityExecutableReachabilityPct: Math.round(liqExecutablePct * 100) / 100,
    productionExecutableReachabilityPct: Math.round(prodExecutablePct * 100) / 100,
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
  console.log("Running topology experiment (P4.8.3 — independent replicates)...");
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

        // Capture INITIAL reachability (before simulation).
        const initialMetrics = extractMetrics(world);

        // Run simulation, capturing reachability every 10 steps.
        const rng = new SeededRNG(seed);
        const timeSeriesMetrics: RunMetrics[] = [initialMetrics];
        for (let step = 0; step < config.totalSteps; step++) {
          simulateStep(world, rng);
          if ((step + 1) % 10 === 0 || step === config.totalSteps - 1) {
            timeSeriesMetrics.push(extractMetrics(world));
          }
        }

        // Final metrics + time-series summary.
        const finalMetrics = extractMetrics(world);
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
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  dRamp Topology Experiment (P4.8.3 — Independent Replicates)   ║");
  console.log("║  20 seeds | 100 steps | Per-seed canonical pool | Deep clone   ║");
  console.log("║  Controls: no entry/exit, no incentives, no shocks              ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // Table A: Four-level reachability
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

  // Conclusion: Topology / Depletion / Execution decomposition
  console.log("\n### Conclusion: Topology / Depletion / Execution Decomposition\n");
  for (const topo of TOPOLOGIES) {
    const r100 = results.find(r => r.density === 100 && r.topology === topo);
    if (r100) {
      const medInitial = percentile(r100.metrics.map(m => (m as any).initialProdExecReach ?? 0), 0.5);
      const medFinal = percentile(r100.metrics.map(m => (m as any).finalProdExecReach ?? 0), 0.5);
      const medMean = percentile(r100.metrics.map(m => (m as any).meanProdExecReach ?? 0), 0.5);
      const medDepletion = percentile(r100.metrics.map(m => (m as any).depletionPct ?? 0), 0.5);
      const medComp = percentile(r100.metrics.map(m => m.completionRate), 0.5);
      const medMultiHop = percentile(r100.metrics.map(m => m.multiHopPercentage), 0.5);
      console.log(`  ${topo} @ 100:`);
      console.log(`    Topology effect:    initial prod-exec = ${medInitial.toFixed(1)}%`);
      console.log(`    Depletion effect:   final prod-exec = ${medFinal.toFixed(1)}% (decline ${medDepletion.toFixed(1)}%)`);
      console.log(`    Time-averaged:      mean prod-exec = ${medMean.toFixed(1)}%`);
      console.log(`    Execution effect:   completion = ${medComp.toFixed(1)}%`);
      console.log(`    Multi-hop share:    ${medMultiHop.toFixed(1)}%`);
    }
  }
}

const results = runExperiment();
printResults(results);
console.log("\nExperiment complete.");
