// dRamp Prompt 4.8.1 — Controlled Graph Density Experiment
//
// Fixes the confounding flaw: demand generation is separated from provider
// generation using independent RNG streams. A canonical 100-provider pool is
// generated once; each density takes the first N providers. Three topology
// modes (RANDOM, CORRIDOR_FOCUSED, BRIDGED) isolate the graph-structure effect.
//
// Usage: bun experiments/p4-topology-experiment.ts

import { simulateStep } from "../src/lib/simulator/engine-faithful";
import { createWorld, createDefaultConfig, toUsdValue } from "../src/lib/simulator/world";
import { SeededRNG } from "../src/lib/simulator/rng";
import {
  SimWorld, SimConfig, SimProvider, SimOffer, SimUser, SimSettlementAsset,
  SimCampaign, SimLiquidityInventory, SettlementReliabilityProfile,
  DEFAULT_RELIABILITY_PROFILES,
} from "../src/lib/simulator/world";
import { calculateProviderEconomics } from "../src/lib/economics/shared";

// ---- Constants (match generator.ts) ----
const COUNTRIES = ["US", "EU", "NG", "PH", "KE", "GB", "SG", "JP", "IN", "BR"];
const ASSETS = ["USD", "EUR", "NGN", "PHP", "KES", "GBP", "SGD", "JPY", "INR", "BRL"];
const PROVIDER_TYPES = ["LOCAL_FIAT_AGENT", "PSP", "BANK", "CEX", "DEX", "STABLECOIN_LP", "MARKET_MAKER", "TREASURY"];
const TRUST_MODELS = ["COLLATERALIZED", "INSTITUTIONALLY_TRUSTED", "PRE_FUNDED", "NON_CUSTODIAL"];
const STRATEGIES = ["AGGRESSIVE", "PREMIUM", "LIQUIDITY_MAXIMIZER", "MARKET_MAKER", "INCENTIVE_SEEKER", "CONSERVATIVE", "OPPORTUNISTIC"];
const PROVIDER_NAMES = ["Northbridge", "SwiftPay", "Meridian", "Atlas", "OpenSwap", "Sahara", "Continental", "Pacific", "GlobalBridge", "TransContinental", "FastCorridor", "LiquidityHub", "CapitalFlow", "EdgeExchange", "DirectRoute", "PrimeLiquidity", "ValueBridge", "SpeedTransfer", "TrustFlow", "OpenMarket"];

let idCounter = 0;
function nextId(prefix: string): string { return `${prefix}_${++idCounter}`; }

// ---- Topology modes ----
type TopologyMode = "RANDOM" | "CORRIDOR_FOCUSED" | "BRIDGED";

// High-demand corridors (most common remittance routes).
const HIGH_DEMAND_CORRIDORS: Array<[string, string, string, string]> = [
  ["USD", "US", "NGN", "NG"],
  ["USD", "US", "PHP", "PH"],
  ["USD", "US", "KES", "KE"],
  ["USD", "US", "INR", "IN"],
  ["EUR", "EU", "NGN", "NG"],
  ["GBP", "GB", "NGN", "NG"],
  ["USD", "US", "EUR", "EU"],
  ["SGD", "SG", "PHP", "PH"],
];

// ---- Generate demand population (frozen across densities) ----
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

// Derive the top demanded corridors from the frozen demand population.
// Returns corridors sorted by demand weight (frequency × typical amount).
export function deriveDemandCorridors(users: SimUser[]): Array<[string, string, string, string]> {
  const corridorDemand = new Map<string, { srcAsset: string; srcCountry: string; dstAsset: string; dstCountry: string; weight: number }>();
  for (const u of users) {
    const key = `${u.sourceAsset}:${u.sourceCountry}:${u.destinationAsset}:${u.destinationCountry}`;
    const existing = corridorDemand.get(key);
    const weight = u.frequency * u.typicalAmount;
    if (existing) {
      existing.weight += weight;
    } else {
      corridorDemand.set(key, { srcAsset: u.sourceAsset, srcCountry: u.sourceCountry, dstAsset: u.destinationAsset, dstCountry: u.destinationCountry, weight });
    }
  }
  // Sort by weight descending, return top corridors.
  const sorted = [...corridorDemand.values()].sort((a, b) => b.weight - a.weight);
  return sorted.map(c => [c.srcAsset, c.srcCountry, c.dstAsset, c.dstCountry] as [string, string, string, string]);
}

// ---- Generate canonical 100-provider pool ----
// demandDerivedCorridors: top corridors from the frozen demand population.
// Used by CORRIDOR_FOCUSED topology to place capacity where demand actually is.
export function generateCanonicalProviders(
  seed: number, count: number, topology: TopologyMode,
  settlementAssets: Map<string, SimSettlementAsset>,
  demandDerivedCorridors: Array<[string, string, string, string]>,
): SimProvider[] {
  const rng = new SeededRNG(seed);
  const providers: SimProvider[] = [];
  const stableAssetList = [...settlementAssets.values()].filter(a => a.isEligibleCollateral);

  for (let i = 0; i < count; i++) {
    const providerId = `prov_${i}`;
    const providerType = rng.pick(PROVIDER_TYPES);
    const strategy = rng.pick(STRATEGIES);
    const trustModel = rng.pick(TRUST_MODELS);
    const name = `${PROVIDER_NAMES[i % PROVIDER_NAMES.length]} ${String.fromCharCode(65 + (i % 26))}`;
    const collateral = rng.float(10000, 100000);
    const collateralHaircut = rng.pick(stableAssetList).collateralHaircut;
    const usableCollateral = collateral * (1 - collateralHaircut);
    const maxExposure = usableCollateral / 1.5;

    const corridors: string[] = [];
    const offers: SimOffer[] = [];

    if (topology === "RANDOM") {
      const numCorridors = rng.int(1, 3);
      const usedPairs = new Set<string>();
      for (let c = 0; c < numCorridors; c++) {
        let srcIdx: number, dstIdx: number;
        do {
          srcIdx = rng.int(0, ASSETS.length - 1);
          dstIdx = rng.int(0, ASSETS.length - 1);
        } while (srcIdx === dstIdx || usedPairs.has(`${srcIdx}-${dstIdx}`));
        usedPairs.add(`${srcIdx}-${dstIdx}`);
        corridors.push(`${ASSETS[srcIdx]}:${COUNTRIES[srcIdx]}:${ASSETS[dstIdx]}:${COUNTRIES[dstIdx]}`);
        const settlementAsset = rng.pick(stableAssetList);
        const feeBps = rng.int(5, 35);
        offers.push(makeOffer(providerId, ASSETS[srcIdx], ASSETS[dstIdx], COUNTRIES[srcIdx], COUNTRIES[dstIdx], rng.float(0.8, 1.2), feeBps, settlementAsset.id, rng));
      }
    } else if (topology === "CORRIDOR_FOCUSED") {
      // Providers concentrate on corridors DERIVED FROM ACTUAL DEMAND.
      const numCorridors = rng.int(1, 3);
      for (let c = 0; c < numCorridors; c++) {
        const corridor = rng.pick(demandDerivedCorridors);
        corridors.push(`${corridor[0]}:${corridor[1]}:${corridor[2]}:${corridor[3]}`);
        const settlementAsset = rng.pick(stableAssetList);
        const feeBps = rng.int(5, 35);
        offers.push(makeOffer(providerId, corridor[0], corridor[2], corridor[1], corridor[3], rng.float(0.8, 1.2), feeBps, settlementAsset.id, rng));
      }
    } else if (topology === "BRIDGED") {
      const role = rng.next();
      if (role < 0.5) {
        const corridor = rng.pick(demandDerivedCorridors);
        corridors.push(`${corridor[0]}:${corridor[1]}:${corridor[2]}:${corridor[3]}`);
        const settlementAsset = rng.pick(stableAssetList);
        offers.push(makeOffer(providerId, corridor[0], corridor[2], corridor[1], corridor[3], rng.float(0.8, 1.2), rng.int(5, 35), settlementAsset.id, rng));
      } else {
        const sa = rng.pick(stableAssetList);
        const fiatIdx = rng.int(0, ASSETS.length - 1);
        const fiatAsset = ASSETS[fiatIdx];
        const fiatCountry = COUNTRIES[fiatIdx];
        if (rng.chance(0.5)) {
          corridors.push(`${fiatAsset}:${fiatCountry}:${sa.symbol}:GLOBAL`);
          offers.push(makeOffer(providerId, fiatAsset, sa.symbol, fiatCountry, "GLOBAL", 1.0, rng.int(3, 10), sa.id, rng));
        } else {
          corridors.push(`${sa.symbol}:GLOBAL:${fiatAsset}:${fiatCountry}`);
          offers.push(makeOffer(providerId, sa.symbol, fiatAsset, "GLOBAL", fiatCountry, 1.0, rng.int(3, 10), sa.id, rng));
        }
      }
    }

    const provider = makeProvider(providerId, name, providerType, trustModel, strategy, collateral, usableCollateral, maxExposure, corridors, rng, offers);
    providers.push(provider);
  }

  return providers;
}

// Helper to make an offer (uses SeededRNG for full reproducibility)
function makeOffer(providerId: string, srcAsset: string, dstAsset: string, srcCountry: string, dstCountry: string, rate: number, feeBps: number, settlementAssetId: string, rng: SeededRNG): SimOffer {
  return {
    id: nextId("offer"), providerId,
    capability: "FIAT_IN", sourceAsset: srcAsset, destinationAsset: dstAsset,
    sourceCountry: srcCountry, destinationCountry: dstCountry,
    rate, feeBps, minimumAmount: 10, maximumAmount: 1000000000,
    availableCapacity: rng.float(5000, 50000), reservedCapacity: 0,
    settlementAssetId, channelType: "AUTOMATIC",
    expectedExecutionSeconds: rng.int(10, 120),
    incentiveBps: 0, active: true, version: 1,
    settlementDurationSteps: 1,
  };
}

// Helper to make a provider
function makeProvider(id: string, name: string, providerType: string, trustModel: string, strategy: string, collateral: number, usableCollateral: number, maxExposure: number, corridors: string[], rng: SeededRNG, offers: SimOffer[]): SimProvider {
  const baseProfile = DEFAULT_RELIABILITY_PROFILES[providerType] ?? DEFAULT_RELIABILITY_PROFILES.HYBRID;
  const variation = rng.float(-0.02, 0.02);
  const reliabilityProfile: SettlementReliabilityProfile = {
    fastRate: Math.max(0.5, Math.min(0.999, baseProfile.fastRate + variation)),
    delayedRate: Math.max(0, baseProfile.delayedRate - variation * 0.5),
    retryRate: Math.max(0, baseProfile.retryRate - variation * 0.3),
    failureRate: Math.max(0, baseProfile.failureRate - variation * 0.2),
  };

  // Build liquidity from corridors
  const liquidityBalances = new Map<string, number>();
  const treasuryBalances = new Map<string, number>();
  for (const corridor of corridors) {
    const parts = corridor.split(":");
    if (parts.length < 4) continue;
    const srcAsset = parts[0];
    const dstAsset = parts[2];
    liquidityBalances.set(srcAsset, (liquidityBalances.get(srcAsset) ?? 0) + collateral * rng.float(0.2, 0.6));
    liquidityBalances.set(dstAsset, (liquidityBalances.get(dstAsset) ?? 0) + collateral * rng.float(0.05, 0.25));
    treasuryBalances.set(srcAsset, (treasuryBalances.get(srcAsset) ?? 0) + collateral * rng.float(0.4, 1.2));
    treasuryBalances.set(dstAsset, (treasuryBalances.get(dstAsset) ?? 0) + collateral * rng.float(0.1, 0.5));
  }

  return {
    id, name, providerType, trustModel,
    reputationScore: rng.float(0.5, 0.9), tier: "VERIFIED", status: "ACTIVE", exitReason: null,
    strategy, collateral, usableCollateral, lockedCollateral: 0, maxExposure, corridors,
    liquidity: { balances: liquidityBalances },
    encumbered: { balances: new Map() },
    treasury: { balances: treasuryBalances },
    totalReplenished: 0,
    reliabilityProfile,
    totalVolume: 0, totalEarnings: 0, totalIncentives: 0, totalPenalties: 0, totalSlashing: 0,
    executionsCompleted: 0, executionsFailed: 0,
    settlementsFast: 0, settlementsDelayed: 0, settlementsRetried: 0, settlementsFailed: 0,
    utilization: 0, peakUtilization: 0, utilizationTimeSteps: 0,
    entryStep: 0, exitStep: null, totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
    executionHistory: [],
  };
}

// ---- Build a world with frozen demand and canonical providers ----
function buildControlledWorld(
  seed: number,
  providerCount: number,
  topology: TopologyMode,
  demandPopulation: SimUser[],
  canonicalProviders: SimProvider[],
  config: SimConfig,
): SimWorld {
  idCounter = 0; // reset for deterministic IDs
  const world = createWorld(config);
  const rng = new SeededRNG(seed);

  // Settlement assets (deterministic, no RNG).
  const usdc: SimSettlementAsset = { id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" };
  const eurc: SimSettlementAsset = { id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" };
  const sc: SimSettlementAsset = { id: "asset_sc", symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT", volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0, incentiveRate: 0, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE" };
  const weth: SimSettlementAsset = { id: "asset_weth", symbol: "WETH", assetType: "VOLATILE_TOKEN", volatilityScore: 0.6, liquidityScore: 0.6, pegQuality: null, incentiveRate: 0, collateralHaircut: 0.5, isEligibleCollateral: false, status: "ACTIVE" };
  const settlementAssets = new Map<string, SimSettlementAsset>([["asset_usdc", usdc], ["asset_eurc", eurc], ["asset_sc", sc], ["asset_weth", weth]]);
  for (const sa of settlementAssets.values()) world.assets.set(sa.id, sa);

  // Add canonical providers (first N).
  for (let i = 0; i < providerCount; i++) {
    const p = canonicalProviders[i];
    world.providers.set(p.id, p);
    // Re-add offers for this provider (they reference the provider).
    // We need to regenerate offers deterministically using the same topology.
  }

  // Re-generate offers for the selected providers using a separate RNG.
  // This is needed because offers were created during canonical generation
  // but we need to ensure they're in the world's offers map.
  const offerRng = new SeededRNG(seed + 100000);
  const stableAssetList = [...settlementAssets.values()].filter(a => a.isEligibleCollateral);
  for (let i = 0; i < providerCount; i++) {
    const p = canonicalProviders[i];
    // Re-generate offers matching the topology (using the same corridors).
    generateOffersForProvider(world, p, topology, offerRng, stableAssetList, settlementAssets);
  }

  // Compute settlement durations.
  const stepSeconds = config.stepDurationMs / 1000;
  for (const o of world.offers.values()) {
    o.settlementDurationSteps = Math.max(1, Math.ceil(o.expectedExecutionSeconds / stepSeconds));
  }

  // Add frozen demand population (identical across densities).
  for (const user of demandPopulation) {
    world.users.set(user.id, user);
  }

  return world;
}

function generateOffersForProvider(world: SimWorld, provider: SimProvider, topology: TopologyMode, rng: SeededRNG, stableAssets: SimSettlementAsset[], settlementAssets: Map<string, SimSettlementAsset>) {
  const corridors = provider.corridors;
  for (const corridor of corridors) {
    const parts = corridor.split(":");
    if (parts.length < 4) continue;
    const srcAsset = parts[0];
    const srcCountry = parts[1];
    const dstAsset = parts[2];
    const dstCountry = parts[3];
    const settlementAsset = rng.pick(stableAssets);
    const feeBps = rng.int(5, 35);
    const offer: SimOffer = {
      id: nextId("offer"), providerId: provider.id,
      capability: "FIAT_IN", sourceAsset: srcAsset, destinationAsset: dstAsset,
      sourceCountry: srcCountry, destinationCountry: dstCountry,
      rate: rng.float(0.8, 1.2), feeBps, minimumAmount: 10, maximumAmount: 1000000000,
      availableCapacity: rng.float(5000, 50000), reservedCapacity: 0,
      settlementAssetId: settlementAsset.id, channelType: "AUTOMATIC",
      expectedExecutionSeconds: rng.int(10, 120),
      incentiveBps: 0, active: true, version: 1,
      settlementDurationSteps: 1,
    };
    world.offers.set(offer.id, offer);
  }
}

// ---- Metrics extraction (enhanced) ----
interface RunMetrics {
  routeCoverage: number;
  completionRate: number;
  abandonmentRate: number;
  servedCostBps: number;        // avg cost among completed only
  effectiveCostBps: number;     // includes penalty for unserved demand
  p50LatencySteps: number;
  p95LatencySteps: number;
  avgUtilization: number;
  medianNetProfit: number;
  medianNetMargin: number;
  hhi: number;
  routeCompetition: number;
  multiHopPercentage: number;   // % of completed routes using multi-hop
  totalVolume: number;
  liquidityDepth: number;
  protocolRevenue: number;
  demandServedPct: number;      // % of total demand volume served
  // Graph metrics
  reachablePairs: number;       // # of (source,dest) pairs with at least 1 route
  totalDemandPairs: number;     // total # of unique demanded pairs
  corridorsWithMultipleRoutes: number; // # of demanded corridors with ≥2 independent routes
}

function extractMetrics(world: any, unservedPenaltyBps: number): RunMetrics {
  const intents = world.intents;
  const completed = intents.filter((i: any) => i.status === "COMPLETED");
  const abandoned = intents.filter((i: any) => i.status === "ABANDONED");
  const expired = intents.filter((i: any) => i.status === "EXPIRED");
  const failed = intents.filter((i: any) => i.status === "FAILED");
  const unserved = intents.filter((i: any) => i.status !== "COMPLETED");

  const costs = completed.map((i: any) => i.effectiveCost / i.sourceAmount * 10000);
  const servedCostBps = costs.length > 0 ? costs.reduce((s: number, c: number) => s + c, 0) / costs.length : 0;

  // Effective cost: served demand at actual cost + unserved demand at penalty.
  const totalDemandVolume = intents.reduce((s: number, i: any) => s + i.sourceAmount, 0);
  const servedVolume = completed.reduce((s: number, i: any) => s + i.sourceAmount, 0);
  const unservedVolume = totalDemandVolume - servedVolume;
  const totalCost = completed.reduce((s: number, i: any) => s + i.effectiveCost, 0) + unservedVolume * unservedPenaltyBps / 10000;
  const effectiveCostBps = totalDemandVolume > 0 ? totalCost / totalDemandVolume * 10000 : 0;

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

  // Multi-hop: check transfers (multi-hop routes have settlement transfers).
  const multiHopCount = world.settlementTransfers.filter((t: any) => t.status === "COMPLETED").length;
  const multiHopPercentage = completed.length > 0 ? (multiHopCount / completed.length) * 100 : 0;

  // Graph metrics: reachable pairs from active offers.
  const offeredPairs = new Set<string>();
  for (const o of world.offers.values()) {
    if (!o.active) continue;
    offeredPairs.add(`${o.sourceAsset}→${o.destinationAsset}`);
  }
  // Demanded pairs from users.
  const demandedPairs = new Set<string>();
  for (const u of world.users.values()) {
    demandedPairs.add(`${u.sourceAsset}→${u.destinationAsset}`);
  }
  // Also check multi-hop reachability via settlement assets.
  const settlementAssetSymbols = new Set([...world.assets.values()].map((a: any) => a.symbol));
  let reachablePairs = 0;
  let corridorsWithMultipleRoutes = 0;
  for (const pair of demandedPairs) {
    const [src, dst] = pair.split("→");
    // Direct?
    const directOffers = [...world.offers.values()].filter((o: any) => o.active && o.sourceAsset === src && o.destinationAsset === dst);
    if (directOffers.length > 0) {
      reachablePairs++;
      if (directOffers.length >= 2) corridorsWithMultipleRoutes++;
      continue;
    }
    // Multi-hop via settlement asset?
    let foundMultiHop = false;
    for (const sa of settlementAssetSymbols) {
      const hop1 = [...world.offers.values()].filter((o: any) => o.active && o.sourceAsset === src && o.destinationAsset === sa);
      const hop2 = [...world.offers.values()].filter((o: any) => o.active && o.sourceAsset === sa && o.destinationAsset === dst);
      if (hop1.length > 0 && hop2.length > 0) {
        foundMultiHop = true;
        break;
      }
    }
    if (foundMultiHop) {
      reachablePairs++;
      // Check for multiple routes (simplified).
      if (directOffers.length >= 2) corridorsWithMultipleRoutes++;
    }
  }

  // Route competition: avg offers per offered pair.
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
    routeCoverage: intents.length > 0 ? (intents.filter((i: any) => i.status === "COMPLETED" || i.status === "EXECUTING" || i.status === "FAILED").length / intents.length) * 100 : 0,
    completionRate: intents.length > 0 ? (completed.length / intents.length) * 100 : 0,
    abandonmentRate: intents.length > 0 ? (abandoned.length / intents.length) * 100 : 0,
    servedCostBps: Math.round(servedCostBps * 100) / 100,
    effectiveCostBps: Math.round(effectiveCostBps * 100) / 100,
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
    reachablePairs,
    totalDemandPairs: demandedPairs.size,
    corridorsWithMultipleRoutes,
  };
}

// ---- Statistics ----
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
}
function statsLabel(arr: number[]): string {
  return `${percentile(arr, 0.5).toFixed(1)} (${percentile(arr, 0.1).toFixed(1)}–${percentile(arr, 0.9).toFixed(1)})`;
}

// ---- Main experiment ----
const PROVIDER_COUNTS = [5, 10, 20, 50, 100];
const TOPOLOGIES: TopologyMode[] = ["RANDOM", "CORRIDOR_FOCUSED", "BRIDGED"];
const NUM_SEEDS = 20;
const BASE_SEED = 10000;
const UNSERVED_PENALTY_BPS = 300; // unserved demand costs full baseline

function makeConfig(seed: number): SimConfig {
  return {
    ...createDefaultConfig(),
    seed,
    totalSteps: 100,
    stepDurationMs: 60000,
    initialProviders: 0, // we add them manually
    providerGrowthRate: 0.0,
    providerExitThreshold: -999,
    demandVolume: 10,
    demandGrowth: 0.0,
    enableIncentives: false,
    shockType: null,
    shockStep: 999,
    shockMagnitude: 0,
    enableLiquidityInventory: true,
    enableStochasticSettlement: true,
    enableDemandPatience: true,
    defaultMaxAcceptablePriceBps: 400,
    defaultMaxAcceptableLatencySteps: 30,
    liquidityReplenishSteps: 10,
  };
}

function runExperiment() {
  console.log("Running topology experiment...");
  console.log(`  ${PROVIDER_COUNTS.length} densities × ${TOPOLOGIES.length} topologies × ${NUM_SEEDS} seeds = ${PROVIDER_COUNTS.length * TOPOLOGIES.length * NUM_SEEDS} runs`);

  interface Result { density: number; topology: string; metrics: RunMetrics[] }
  const results: Result[] = [];

  for (const topology of TOPOLOGIES) {
    // Generate canonical 100-provider pool ONCE per topology (separate seed).
    const canonicalSeed = BASE_SEED + 99999;
    const settlementAssets = new Map<string, SimSettlementAsset>([
      ["asset_usdc", { id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" }],
      ["asset_eurc", { id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" }],
      ["asset_sc", { id: "asset_sc", symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT", volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0, incentiveRate: 0, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE" }],
      ["asset_weth", { id: "asset_weth", symbol: "WETH", assetType: "VOLATILE_TOKEN", volatilityScore: 0.6, liquidityScore: 0.6, pegQuality: null, incentiveRate: 0, collateralHaircut: 0.5, isEligibleCollateral: false, status: "ACTIVE" }],
    ]);

    // Derive demand corridors from seed 0's demand population (frozen).
    const seed0Config = makeConfig(BASE_SEED);
    const seed0Demand = generateDemandPopulation(BASE_SEED, 50, seed0Config);
    const demandDerivedCorridors = deriveDemandCorridors(seed0Demand);

    const canonicalProviders = generateCanonicalProviders(canonicalSeed, 100, topology, settlementAssets, demandDerivedCorridors);

    for (const density of PROVIDER_COUNTS) {
      const metrics: RunMetrics[] = [];
      for (let s = 0; s < NUM_SEEDS; s++) {
        const seed = BASE_SEED + s;
        const config = makeConfig(seed);

        // Generate demand ONCE per seed (frozen across densities).
        const demandPopulation = generateDemandPopulation(seed, 50, config);

        // Build world with frozen demand + first N canonical providers.
        const world = buildControlledWorld(seed, density, topology, demandPopulation, canonicalProviders, config);

        // Run simulation manually (not via runSimulation which calls generateWorld).
        const rng = new SeededRNG(seed);
        for (let step = 0; step < config.totalSteps; step++) {
          simulateStep(world, rng);
        }

        metrics.push(extractMetrics(world, UNSERVED_PENALTY_BPS));
      }
      results.push({ density, topology, metrics });
      process.stderr.write(`  Done: ${density} providers / ${topology} (${NUM_SEEDS} seeds)\n`);
    }
  }

  return results;
}

function printResults(results: Result[]) {
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  dRamp Controlled Topology Experiment (Post-Calibration)        ║");
  console.log("║  Simulator: 1c2c133 | 20 seeds | 100 steps | Demand frozen      ║");
  console.log("║  Controls: no entry/exit, no incentives, no shocks               ║");
  console.log("║  Unserved penalty: 300 bps (full baseline cost)                  ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // Table A: Coverage × topology
  console.log("\n### Table A — Route Coverage % by Density × Topology\n");
  console.log("| Providers | RANDOM | CORRIDOR_FOCUSED | BRIDGED |");
  console.log("| --- | --- | --- | --- |");
  for (const density of PROVIDER_COUNTS) {
    const row = [`| ${density} |`];
    for (const topo of TOPOLOGIES) {
      const r = results.find(r => r.density === density && r.topology === topo);
      if (r) {
        const vals = r.metrics.map(m => m.routeCoverage);
        row.push(` ${statsLabel(vals)} |`);
      } else {
        row.push(" — |");
      }
    }
    console.log(row.join(""));
  }

  // Table B: Completion + cost
  console.log("\n### Table B — Completion % / Served Cost / Effective Cost\n");
  console.log("| Providers | Topology | Completion % | Served cost (bps) | Effective cost (bps) |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const comp = r.metrics.map(m => m.completionRate);
    const sc = r.metrics.map(m => m.servedCostBps);
    const ec = r.metrics.map(m => m.effectiveCostBps);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(comp)} | ${statsLabel(sc)} | ${statsLabel(ec)} |`);
  }

  // Table C: Provider economics
  console.log("\n### Table C — Provider Economics\n");
  console.log("| Providers | Topology | Avg util % | Median profit $ | Median margin % | Multi-hop % |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const au = r.metrics.map(m => m.avgUtilization);
    const mp = r.metrics.map(m => m.medianNetProfit);
    const mm = r.metrics.map(m => m.medianNetMargin);
    const mh = r.metrics.map(m => m.multiHopPercentage);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(au)} | ${statsLabel(mp)} | ${statsLabel(mm)} | ${statsLabel(mh)} |`);
  }

  // Table D: Graph connectivity
  console.log("\n### Table D — Graph Connectivity\n");
  console.log("| Providers | Topology | Reachable pairs | Total demand pairs | Multiple routes | Demand served % |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const rp = r.metrics.map(m => m.reachablePairs);
    const tp = r.metrics.map(m => m.totalDemandPairs);
    const mr = r.metrics.map(m => m.corridorsWithMultipleRoutes);
    const ds = r.metrics.map(m => m.demandServedPct);
    console.log(`| ${r.density} | ${r.topology} | ${statsLabel(rp)} | ${statsLabel(tp)} | ${statsLabel(mr)} | ${statsLabel(ds)} |`);
  }

  // Conclusion
  console.log("\n### Conclusion\n");
  // Find best topology at 100 providers.
  for (const topo of TOPOLOGIES) {
    const r100 = results.find(r => r.density === 100 && r.topology === topo);
    if (r100) {
      const medComp = percentile(r100.metrics.map(m => m.completionRate), 0.5);
      const medCov = percentile(r100.metrics.map(m => m.routeCoverage), 0.5);
      const medEffCost = percentile(r100.metrics.map(m => m.effectiveCostBps), 0.5);
      const medMultiHop = percentile(r100.metrics.map(m => m.multiHopPercentage), 0.5);
      console.log(`  ${topo} @ 100 providers: coverage=${medCov.toFixed(1)}%, completion=${medComp.toFixed(1)}%, effective cost=${medEffCost.toFixed(1)} bps, multi-hop=${medMultiHop.toFixed(1)}%`);
    }
  }
}

const results = runExperiment();
printResults(results);
console.log("\nExperiment complete.");
