// dRamp Network Simulator — Synthetic World Generator
//
// Generates heterogeneous users, providers, offers, assets, and campaigns
// into a SimWorld. All deterministic via SeededRNG.

import { SeededRNG } from "./rng";
import {
  SimWorld, SimConfig, SimProvider, SimOffer, SimUser,
  SimSettlementAsset, SimCampaign,
} from "./world";

const COUNTRIES = ["US", "EU", "NG", "PH", "KE", "GB", "SG", "JP", "IN", "BR"];
const ASSETS = ["USD", "EUR", "NGN", "PHP", "KES", "GBP", "SGD", "JPY", "INR", "BRL"];
const PROVIDER_TYPES = ["LOCAL_FIAT_AGENT", "PSP", "BANK", "CEX", "DEX", "STABLECOIN_LP", "MARKET_MAKER", "TREASURY"];
const TRUST_MODELS = ["COLLATERALIZED", "INSTITUTIONALLY_TRUSTED", "PRE_FUNDED", "NON_CUSTODIAL"];
const STRATEGIES = ["AGGRESSIVE", "PREMIUM", "LIQUIDITY_MAXIMIZER", "MARKET_MAKER", "INCENTIVE_SEEKER", "CONSERVATIVE", "OPPORTUNISTIC"];
const PROVIDER_NAMES = ["Northbridge", "SwiftPay", "Meridian", "Atlas", "OpenSwap", "Sahara", "Continental", "Pacific", "GlobalBridge", "TransContinental", "FastCorridor", "LiquidityHub", "CapitalFlow", "EdgeExchange", "DirectRoute", "PrimeLiquidity", "ValueBridge", "SpeedTransfer", "TrustFlow", "OpenMarket"];

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${++idCounter}`;
}

export function generateWorld(world: SimWorld, rng: SeededRNG): void {
  const config = world.config;

  // ---- Settlement Assets ----
  const usdc: SimSettlementAsset = {
    id: nextId("asset"), symbol: "USDC", assetType: "STABLECOIN",
    volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99,
    incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE",
  };
  const eurc: SimSettlementAsset = {
    id: nextId("asset"), symbol: "EURC", assetType: "STABLECOIN",
    volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95,
    incentiveRate: 40, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE",
  };
  const sc: SimSettlementAsset = {
    id: nextId("asset"), symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT",
    volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0,
    incentiveRate: 25, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE",
  };
  const weth: SimSettlementAsset = {
    id: nextId("asset"), symbol: "WETH", assetType: "VOLATILE_TOKEN",
    volatilityScore: 0.6, liquidityScore: 0.6, pegQuality: null,
    incentiveRate: 0, collateralHaircut: 0.5, isEligibleCollateral: false, status: "ACTIVE",
  };
  world.assets.set(usdc.id, usdc);
  world.assets.set(eurc.id, eurc);
  world.assets.set(sc.id, sc);
  world.assets.set(weth.id, weth);
  const assetList = [usdc, eurc, sc, weth];
  const stableAssets = [usdc, eurc, sc];

  // ---- Incentive Campaigns ----
  if (config.enableIncentives) {
    const campaign1: SimCampaign = {
      id: nextId("camp"), settlementAssetId: eurc.id,
      name: "EURC Bootstrap", incentiveBps: 40, totalBudget: 5000,
      accrued: 0, paid: 0, status: "ACTIVE", startStep: 0, endStep: config.totalSteps,
    };
    const campaign2: SimCampaign = {
      id: nextId("camp"), settlementAssetId: sc.id,
      name: "SC Settlement Reward", incentiveBps: 25, totalBudget: 2000,
      accrued: 0, paid: 0, status: "ACTIVE", startStep: 0, endStep: config.totalSteps,
    };
    world.campaigns.set(campaign1.id, campaign1);
    world.campaigns.set(campaign2.id, campaign2);
  }

  // ---- Providers ----
  for (let i = 0; i < config.initialProviders; i++) {
    generateProvider(world, rng, assetList, stableAssets, i);
  }

  // ---- Users ----
  const numUsers = 50;
  for (let i = 0; i < numUsers; i++) {
    generateUser(world, rng, config);
  }
}

function generateProvider(
  world: SimWorld, rng: SeededRNG,
  assetList: SimSettlementAsset[], stableAssets: SimSettlementAsset[],
  index: number,
): void {
  const config = world.config;
  const providerType = rng.pick(PROVIDER_TYPES);
  const strategy = rng.pick(STRATEGIES);
  const trustModel = rng.pick(TRUST_MODELS);
  const name = `${PROVIDER_NAMES[index % PROVIDER_NAMES.length]} ${String.fromCharCode(65 + (index % 26))}`;

  const collateral = rng.float(10000, 100000);
  const collateralHaircut = rng.pick(stableAssets).collateralHaircut;
  const usableCollateral = collateral * (1 - collateralHaircut);
  const maxExposure = usableCollateral / 1.5;

  const provider: SimProvider = {
    id: nextId("prov"), name, providerType, trustModel,
    reputationScore: rng.float(0.5, 0.9), tier: "VERIFIED", status: "ACTIVE",
    exitReason: null,
    strategy, collateral, usableCollateral, lockedCollateral: 0, maxExposure,
    corridors: [], totalVolume: 0, totalEarnings: 0, totalIncentives: 0,
    totalPenalties: 0, totalSlashing: 0, executionsCompleted: 0, executionsFailed: 0,
    utilization: 0, entryStep: 0, exitStep: null,
    totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
    executionHistory: [],
  };
  world.providers.set(provider.id, provider);

  // Generate offers for this provider — 1-3 corridors.
  const numCorridors = rng.int(1, 3);
  const usedPairs = new Set<string>();
  for (let c = 0; c < numCorridors; c++) {
    let srcIdx: number, dstIdx: number;
    do {
      srcIdx = rng.int(0, ASSETS.length - 1);
      dstIdx = rng.int(0, ASSETS.length - 1);
    } while (srcIdx === dstIdx || usedPairs.has(`${srcIdx}-${dstIdx}`));
    usedPairs.add(`${srcIdx}-${dstIdx}`);

    const srcAsset = ASSETS[srcIdx];
    const dstAsset = ASSETS[dstIdx];
    const srcCountry = COUNTRIES[srcIdx];
    const dstCountry = COUNTRIES[dstIdx] === srcCountry ? "GLOBAL" : COUNTRIES[dstIdx];
    provider.corridors.push(`${srcAsset}:${srcCountry}:${dstAsset}:${dstCountry}`);

    // Strategy-based pricing.
    let feeBps: number;
    switch (strategy) {
      case "AGGRESSIVE": feeBps = rng.int(5, 15); break;
      case "PREMIUM": feeBps = rng.int(30, 50); break;
      case "LIQUIDITY_MAXIMIZER": feeBps = rng.int(10, 20); break;
      case "MARKET_MAKER": feeBps = rng.int(8, 18); break;
      case "INCENTIVE_SEEKER": feeBps = rng.int(12, 25); break;
      case "CONSERVATIVE": feeBps = rng.int(25, 40); break;
      case "OPPORTUNISTIC": feeBps = rng.int(15, 35); break;
      default: feeBps = 20;
    }

    const settlementAsset = rng.pick(stableAssets);
    const incentiveBps = settlementAsset.incentiveRate > 0 && (strategy === "INCENTIVE_SEEKER" || rng.chance(0.3))
      ? settlementAsset.incentiveRate : 0;

    const offer: SimOffer = {
      id: nextId("offer"), providerId: provider.id,
      capability: "FIAT_IN", sourceAsset: srcAsset, destinationAsset: dstAsset,
      sourceCountry: srcCountry, destinationCountry: dstCountry,
      rate: rng.float(0.8, 1.2), feeBps,
      minimumAmount: 10, maximumAmount: 1000000,
      availableCapacity: rng.float(5000, 50000), reservedCapacity: 0,
      settlementAssetId: settlementAsset.id,
      channelType: rng.chance(0.8) ? "AUTOMATIC" : "MANUAL",
      expectedExecutionSeconds: rng.int(10, 120),
      incentiveBps, active: true, version: 1,
    };
    world.offers.set(offer.id, offer);
  }
}

function generateUser(world: SimWorld, rng: SeededRNG, config: SimConfig): void {
  const srcIdx = rng.int(0, ASSETS.length - 1);
  let dstIdx = rng.int(0, ASSETS.length - 1);
  while (dstIdx === srcIdx) dstIdx = rng.int(0, ASSETS.length - 1);

  // Risk tolerance distribution.
  const riskRoll = rng.next();
  let riskTolerance: string;
  if (riskRoll < config.riskDistribution.maxReliability) riskTolerance = "MAX_RELIABILITY";
  else if (riskRoll < config.riskDistribution.maxReliability + config.riskDistribution.balanced) riskTolerance = "BALANCED";
  else riskTolerance = "LOWEST_COST";

  // Execution policy distribution.
  const policyRoll = rng.next();
  const executionPolicy = policyRoll < config.policyDistribution.now ? "NOW" : "WAIT_FOR_BETTER";

  // Transaction size distribution (log-normal-ish).
  const sizeBucket = rng.weighted([0.3, 0.4, 0.2, 0.1]); // small, medium, large, xlarge
  const sizes = [[20, 200], [200, 2000], [2000, 20000], [20000, 100000]];
  const [minAmt, maxAmt] = sizes[sizeBucket];
  const typicalAmount = rng.float(minAmt, maxAmt);

  const user: SimUser = {
    id: nextId("user"), name: `User ${world.users.size + 1}`,
    sourceCountry: COUNTRIES[srcIdx], destinationCountry: COUNTRIES[dstIdx],
    sourceAsset: ASSETS[srcIdx], destinationAsset: ASSETS[dstIdx],
    typicalAmount, amountStdDev: typicalAmount * 0.2,
    frequency: rng.float(0.05, 0.3), riskTolerance, executionPolicy,
    maxWaitSeconds: executionPolicy === "WAIT_FOR_BETTER" ? rng.int(60, 600) : 0,
    cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
  };
  world.users.set(user.id, user);
}

// Generate a new provider entering the market (for provider growth simulation).
export function generateNewProvider(
  world: SimWorld, rng: SeededRNG, step: number,
): SimProvider | null {
  if (world.providers.size >= 200) return null; // cap

  const stableAssets = [...world.assets.values()].filter(a => a.isEligibleCollateral && a.status === "ACTIVE");
  if (stableAssets.length === 0) return null;

  const index = world.providers.size;
  const providerType = rng.pick(PROVIDER_TYPES);
  const strategy = rng.pick(STRATEGIES);
  const trustModel = rng.pick(TRUST_MODELS);
  const name = `${PROVIDER_NAMES[index % PROVIDER_NAMES.length]} ${String.fromCharCode(65 + (index % 26))}`;

  const collateral = rng.float(10000, 100000);
  const collateralHaircut = rng.pick(stableAssets).collateralHaircut;
  const usableCollateral = collateral * (1 - collateralHaircut);
  const maxExposure = usableCollateral / 1.5;

  const provider: SimProvider = {
    id: nextId("prov"), name, providerType, trustModel,
    reputationScore: 0.5, tier: "NEW", status: "ACTIVE",
    exitReason: null,
    strategy, collateral, usableCollateral, lockedCollateral: 0, maxExposure,
    corridors: [], totalVolume: 0, totalEarnings: 0, totalIncentives: 0,
    totalPenalties: 0, totalSlashing: 0, executionsCompleted: 0, executionsFailed: 0,
    utilization: 0, entryStep: step, exitStep: null,
    totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
    executionHistory: [],
  };
  world.providers.set(provider.id, provider);

  // Generate 1-2 offers for an underserved or random corridor.
  const numCorridors = rng.int(1, 2);
  for (let c = 0; c < numCorridors; c++) {
    const srcIdx = rng.int(0, ASSETS.length - 1);
    let dstIdx = rng.int(0, ASSETS.length - 1);
    while (dstIdx === srcIdx) dstIdx = rng.int(0, ASSETS.length - 1);

    const srcAsset = ASSETS[srcIdx];
    const dstAsset = ASSETS[dstIdx];
    const srcCountry = COUNTRIES[srcIdx];
    const dstCountry = COUNTRIES[dstIdx] === srcCountry ? "GLOBAL" : COUNTRIES[dstIdx];

    const settlementAsset = rng.pick(stableAssets);
    const feeBps = strategy === "AGGRESSIVE" ? rng.int(5, 15) : rng.int(15, 35);

    const offer: SimOffer = {
      id: nextId("offer"), providerId: provider.id,
      capability: "FIAT_IN", sourceAsset: srcAsset, destinationAsset: dstAsset,
      sourceCountry: srcCountry, destinationCountry: dstCountry,
      rate: rng.float(0.8, 1.2), feeBps,
      minimumAmount: 10, maximumAmount: 1000000,
      availableCapacity: rng.float(5000, 50000), reservedCapacity: 0,
      settlementAssetId: settlementAsset.id,
      channelType: "AUTOMATIC",
      expectedExecutionSeconds: rng.int(10, 120),
      incentiveBps: settlementAsset.incentiveRate > 0 ? settlementAsset.incentiveRate : 0,
      active: true, version: 1,
    };
    world.offers.set(offer.id, offer);
  }

  return provider;
}

export { ASSETS, COUNTRIES };
