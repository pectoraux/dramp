// dRamp Network Simulator — Market Evolution Engine
//
// The core simulation loop. Each step:
//   1. Generate demand (new intents from users)
//   2. Match intents to routes (simplified routing using the sim world)
//   3. Execute matched intents (simulated settlement)
//   4. Update provider offers (strategy-based pricing adjustments)
//   5. Provider entry/exit
//   6. Incentive campaign updates
//   7. Apply market shocks
//   8. Collect metrics

import { SeededRNG } from "./rng";
import {
  SimWorld, SimIntent, SimRoute, SimRouteLeg, SimMetrics,
  SimProvider, SimOffer,
} from "./world";
import { createWorld } from "./world";
import { generateWorld } from "./generator";
import { generateNewProvider } from "./generator";

let intentCounter = 0;
let routeCounter = 0;

export function simulateStep(world: SimWorld, rng: SeededRNG): void {
  world.step++;
  world.timeMs += world.config.stepDurationMs;

  // 1. Generate demand
  generateDemand(world, rng);

  // 2. Match + execute intents
  matchAndExecute(world, rng);

  // 3. Update provider offers (pricing adjustments)
  updateProviderOffers(world, rng);

  // 4. Provider entry/exit
  handleProviderEntryExit(world, rng);

  // 5. Incentive campaign updates
  updateCampaigns(world);

  // 6. Apply market shocks
  applyShocks(world, rng);

  // 7. Collect metrics
  if (world.step % 5 === 0 || world.step === world.config.totalSteps) {
    world.metricsHistory.push(collectMetrics(world));
  }
}

function generateDemand(world: SimWorld, rng: SeededRNG): void {
  const baseDemand = world.config.demandVolume * (1 + world.config.demandGrowth * world.step);
  const numIntents = Math.max(1, Math.round(baseDemand * rng.float(0.7, 1.3)));

  for (let i = 0; i < numIntents; i++) {
    // Pick a random active user.
    const activeUsers = [...world.users.values()];
    if (activeUsers.length === 0) break;
    const user = rng.pick(activeUsers);
    if (!rng.chance(user.frequency)) continue;

    const amount = Math.max(10, rng.gaussian(user.typicalAmount, user.amountStdDev));
    const intent: SimIntent = {
      id: `intent_${++intentCounter}`,
      userId: user.id,
      sourceAmount: amount,
      sourceAsset: user.sourceAsset,
      sourceCountry: user.sourceCountry,
      destinationAsset: user.destinationAsset,
      destinationCountry: user.destinationCountry,
      riskTolerance: user.riskTolerance,
      executionPolicy: user.executionPolicy,
      maxWaitSeconds: user.maxWaitSeconds,
      status: "SEARCHING",
      createdAtStep: world.step,
      completedAtStep: null,
      selectedRouteId: null,
      routeTag: null,
      effectiveCost: 0,
      netOutput: 0,
      waitedSteps: 0,
      failureReason: null,
    };
    world.intents.push(intent);
  }
}

function matchAndExecute(world: SimWorld, rng: SeededRNG): void {
  const activeIntents = world.intents.filter(i => i.status === "SEARCHING" || i.status === "EXECUTING");

  for (const intent of activeIntents) {
    if (intent.status === "SEARCHING") {
      // Find matching offers.
      const matchingOffers = [...world.offers.values()].filter(o =>
        o.active &&
        o.availableCapacity - o.reservedCapacity >= intent.sourceAmount * 0.01 && // some capacity
        o.sourceAsset === intent.sourceAsset &&
        o.destinationAsset === intent.destinationAsset
      );

      // Also check multi-hop (simplified: find 2-hop routes via settlement assets).
      const routes = findRoutes(world, intent, matchingOffers);

      if (routes.length === 0) {
        // No route found — check if intent should expire.
        intent.waitedSteps++;
        const maxWaitSteps = Math.ceil(intent.maxWaitSeconds / (world.config.stepDurationMs / 1000));
        if (intent.waitedSteps > maxWaitSteps && intent.executionPolicy === "WAIT_FOR_BETTER") {
          intent.status = "EXPIRED";
          intent.failureReason = "no route found within max wait";
        } else if (intent.executionPolicy === "NOW" && intent.waitedSteps > 3) {
          intent.status = "EXPIRED";
          intent.failureReason = "no route found";
        }
        continue;
      }

      // Select best route (simplified scoring).
      const bestRoute = selectBestRoute(routes, intent.riskTolerance, world);
      intent.selectedRouteId = bestRoute.id;
      intent.routeTag = bestRoute.tag;
      intent.status = "EXECUTING";

      // Execute immediately (simulated).
      executeIntent(world, intent, bestRoute, rng);
    }
  }
}

interface SimCandidateRoute {
  legs: SimRouteLeg[];
  effectiveCost: number;
  netOutput: number;
  expectedExecutionSeconds: number;
  riskComposite: number;
  tag: string;
  explanation: string;
}

function findRoutes(world: SimWorld, intent: SimIntent, directOffers: SimOffer[]): SimCandidateRoute[] {
  const routes: SimCandidateRoute[] = [];
  const providers = world.providers;

  // Direct routes (single hop).
  for (const offer of directOffers) {
    const provider = providers.get(offer.providerId);
    if (!provider || provider.status !== "ACTIVE") continue;
    if (offer.availableCapacity - offer.reservedCapacity < intent.sourceAmount) continue;

    const fee = intent.sourceAmount * offer.feeBps / 10000;
    const afterFee = intent.sourceAmount - fee;
    const converted = afterFee * offer.rate;
    const incentive = converted * offer.incentiveBps / 10000;
    const netOutput = converted + incentive;
    const effectiveCost = fee;

    routes.push({
      legs: [{
        providerId: provider.id, providerName: provider.name,
        sourceAsset: offer.sourceAsset, destinationAsset: offer.destinationAsset,
        feeBps: offer.feeBps, rate: offer.rate,
        channelType: offer.channelType, amount: intent.sourceAmount,
      }],
      effectiveCost,
      netOutput,
      expectedExecutionSeconds: offer.expectedExecutionSeconds,
      riskComposite: 1 - provider.reputationScore,
      tag: "DIRECT",
      explanation: `Direct ${offer.sourceAsset}→${offer.destinationAsset} via ${provider.name}`,
    });
  }

  // Multi-hop routes via settlement assets (simplified: find USDC/EURC/SC intermediary).
  const settlementAssets = [...world.assets.values()].filter(a =>
    a.status === "ACTIVE" && a.assetType !== "VOLATILE_TOKEN"
  );

  for (const sa of settlementAssets) {
    // Find offers: sourceAsset -> settlementAsset
    const hop1Offers = [...world.offers.values()].filter(o =>
      o.active && o.sourceAsset === intent.sourceAsset && o.destinationAsset === sa.symbol
    );
    // Find offers: settlementAsset -> destinationAsset
    const hop2Offers = [...world.offers.values()].filter(o =>
      o.active && o.sourceAsset === sa.symbol && o.destinationAsset === intent.destinationAsset
    );

    for (const o1 of hop1Offers) {
      const p1 = providers.get(o1.providerId);
      if (!p1 || p1.status !== "ACTIVE") continue;
      for (const o2 of hop2Offers) {
        const p2 = providers.get(o2.providerId);
        if (!p2 || p2.status !== "ACTIVE") continue;

        const fee1 = intent.sourceAmount * o1.feeBps / 10000;
        const afterFee1 = intent.sourceAmount - fee1;
        const midAmount = afterFee1 * o1.rate;
        const fee2 = midAmount * o2.feeBps / 10000;
        const afterFee2 = midAmount - fee2;
        const finalAmount = afterFee2 * o2.rate;
        const incentive = finalAmount * (o1.incentiveBps + o2.incentiveBps) / 10000;
        const netOutput = finalAmount + incentive;
        const effectiveCost = fee1 + fee2;
        const avgRisk = ((1 - p1.reputationScore) + (1 - p2.reputationScore)) / 2;

        routes.push({
          legs: [
            { providerId: p1.id, providerName: p1.name, sourceAsset: o1.sourceAsset, destinationAsset: o1.destinationAsset, feeBps: o1.feeBps, rate: o1.rate, channelType: o1.channelType, amount: intent.sourceAmount },
            { providerId: p2.id, providerName: p2.name, sourceAsset: o2.sourceAsset, destinationAsset: o2.destinationAsset, feeBps: o2.feeBps, rate: o2.rate, channelType: o2.channelType, amount: midAmount },
          ],
          effectiveCost,
          netOutput,
          expectedExecutionSeconds: Math.max(o1.expectedExecutionSeconds, o2.expectedExecutionSeconds),
          riskComposite: avgRisk,
          tag: "MULTI_HOP",
          explanation: `Multi-hop via ${sa.symbol}: ${p1.name} → ${p2.name}`,
        });
      }
    }
  }

  return routes;
}

function selectBestRoute(routes: SimCandidateRoute[], riskTolerance: string, world: SimWorld): SimCandidateRoute & { id: string } {
  if (routes.length === 0) throw new Error("no routes");

  // Score each route based on risk tolerance.
  let weights: { cost: number; speed: number; risk: number; reputation: number };
  switch (riskTolerance) {
    case "MAX_RELIABILITY": weights = { cost: 0.15, speed: 0.15, risk: 0.55, reputation: 0.15 }; break;
    case "BALANCED": weights = { cost: 0.35, speed: 0.20, risk: 0.30, reputation: 0.15 }; break;
    case "LOWEST_COST": weights = { cost: 0.60, speed: 0.15, risk: 0.10, reputation: 0.15 }; break;
    default: weights = { cost: 0.35, speed: 0.20, risk: 0.30, reputation: 0.15 };
  }

  // Normalize and score.
  const costs = routes.map(r => r.effectiveCost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const scored = routes.map(r => {
    const normCost = maxCost === minCost ? 0 : (r.effectiveCost - minCost) / (maxCost - minCost);
    const normSpeed = r.expectedExecutionSeconds / 600;
    const normRisk = r.riskComposite;
    const reputationFactor = world.config.enableReputation ? r.riskComposite : 0.5;
    const penalty = weights.cost * normCost + weights.speed * normSpeed + weights.risk * normRisk + weights.reputation * reputationFactor;
    return { route: r, score: 1 - penalty };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].route;

  // Tag the best.
  if (best === routes.reduce((min, r) => r.effectiveCost < min.effectiveCost ? r : min, routes[0])) best.tag = "CHEAPEST";
  else if (best === routes.reduce((min, r) => r.expectedExecutionSeconds < min.expectedExecutionSeconds ? r : min, routes[0])) best.tag = "FASTEST";
  else best.tag = "BEST";

  return { ...best, id: `route_${++routeCounter}` };
}

function executeIntent(world: SimWorld, intent: SimIntent, route: SimCandidateRoute & { id: string }, rng: SeededRNG): void {
  // Simulate execution outcome.
  const provider = world.providers.get(route.legs[0].providerId);
  if (!provider) {
    intent.status = "FAILED";
    intent.failureReason = "provider not found";
    return;
  }

  // Simulate failure based on provider reliability.
  const failureRate = 1 - provider.reputationScore;
  if (rng.chance(failureRate * 0.1)) { // scale down failure rate
    intent.status = "FAILED";
    intent.failureReason = "provider execution failure";
    provider.executionsFailed++;
    provider.totalPenalties += intent.sourceAmount * 0.001; // 10 bps penalty
    return;
  }

  // Success.
  intent.status = "COMPLETED";
  intent.completedAtStep = world.step;
  intent.effectiveCost = route.effectiveCost;
  intent.netOutput = route.netOutput;
  intent.waitedSteps = world.step - intent.createdAtStep;

  // Update provider economics.
  for (const leg of route.legs) {
    const p = world.providers.get(leg.providerId);
    if (!p) continue;
    const fee = leg.amount * leg.feeBps / 10000;
    p.totalVolume += leg.amount;
    p.totalEarnings += fee;
    p.executionsCompleted++;
    p.reputationScore = Math.min(1.0, p.reputationScore + 0.001); // reputation grows with success
  }

  // Update world totals.
  world.totalVolume += intent.sourceAmount;
  world.totalFees += route.effectiveCost;
}

function updateProviderOffers(world: SimWorld, rng: SeededRNG): void {
  for (const offer of world.offers.values()) {
    const provider = world.providers.get(offer.providerId);
    if (!provider || provider.status !== "ACTIVE" || !offer.active) continue;

    // Strategy-based pricing adjustments.
    const utilization = offer.availableCapacity > 0 ? offer.reservedCapacity / offer.availableCapacity : 0;
    provider.utilization = utilization;

    switch (provider.strategy) {
      case "AGGRESSIVE":
        // Lower fee if utilization is low, raise if high.
        if (utilization < 0.3 && rng.chance(0.1)) offer.feeBps = Math.max(3, offer.feeBps - 1);
        if (utilization > 0.7 && rng.chance(0.1)) offer.feeBps += 1;
        break;
      case "PREMIUM":
        // Keep fees stable, only adjust capacity.
        if (utilization > 0.8 && rng.chance(0.05)) offer.availableCapacity *= 1.1;
        break;
      case "LIQUIDITY_MAXIMIZER":
        // Lower fees to attract flow when utilization is low.
        if (utilization < 0.2 && rng.chance(0.15)) offer.feeBps = Math.max(5, offer.feeBps - 2);
        break;
      case "MARKET_MAKER":
        // Maintain target spread — adjust rate slightly.
        if (rng.chance(0.1)) offer.rate *= rng.float(0.99, 1.01);
        break;
      case "INCENTIVE_SEEKER":
        // Adjust toward incentivized assets.
        if (offer.incentiveBps === 0 && rng.chance(0.05)) {
          // Only seek incentives from assets with ACTIVE campaigns.
          const activeCampaignAssets = new Set(
            [...world.campaigns.values()].filter(c => c.status === "ACTIVE").map(c => c.settlementAssetId)
          );
          const incentivizedAssets = [...world.assets.values()].filter(a => activeCampaignAssets.has(a.id));
          if (incentivizedAssets.length > 0) {
            const sa = rng.pick(incentivizedAssets);
            offer.settlementAssetId = sa.id;
            offer.incentiveBps = sa.incentiveRate;
            offer.version++;
          }
        }
        break;
      case "CONSERVATIVE":
        // Stable pricing, reduce capacity if risk is increasing.
        if (provider.reputationScore < 0.6 && rng.chance(0.1)) offer.availableCapacity *= 0.9;
        break;
      case "OPPORTUNISTIC":
        // Adjust based on corridor demand.
        if (utilization > 0.6 && rng.chance(0.1)) offer.feeBps += 2;
        if (utilization < 0.2 && rng.chance(0.1)) offer.feeBps = Math.max(5, offer.feeBps - 2);
        break;
    }

    // All providers: small random rate drift.
    if (rng.chance(0.05)) offer.rate *= rng.float(0.995, 1.005);
    offer.version++;
  }
}

function handleProviderEntryExit(world: SimWorld, rng: SeededRNG): void {
  // Provider entry.
  if (rng.chance(world.config.providerGrowthRate)) {
    const newProvider = generateNewProvider(world, rng, world.step);
    if (newProvider) {
      // New providers start with lower reputation.
      newProvider.reputationScore = 0.5;
      newProvider.tier = "NEW";
    }
  }

  // Provider exit.
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    // Check exit conditions.
    const steps = world.step - provider.entryStep;
    if (steps < 10) continue; // give providers time to establish

    const avgEarningsPerStep = provider.totalEarnings / Math.max(1, steps);
    const capitalEfficiency = avgEarningsPerStep / Math.max(1, provider.usableCollateral);

    // Exit if earnings are below threshold.
    if (capitalEfficiency < world.config.providerExitThreshold && rng.chance(0.1)) {
      provider.status = "EXITED";
      provider.exitStep = world.step;
      // Deactivate offers.
      for (const offer of world.offers.values()) {
        if (offer.providerId === provider.id) offer.active = false;
      }
    }

    // Exit if too many failures.
    if (provider.executionsFailed > 5 && provider.executionsFailed / Math.max(1, provider.executionsCompleted + provider.executionsFailed) > 0.3) {
      provider.status = "EXITED";
      provider.exitStep = world.step;
      for (const offer of world.offers.values()) {
        if (offer.providerId === provider.id) offer.active = false;
      }
    }
  }

  // Update tiers based on reputation + history.
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const steps = world.step - provider.entryStep;
    if (provider.reputationScore >= 0.85 && provider.executionsCompleted >= 10 && steps >= 30) provider.tier = "PREMIUM";
    else if (provider.reputationScore >= 0.7 && provider.executionsCompleted >= 5 && steps >= 14) provider.tier = "TRUSTED";
    else if (provider.executionsCompleted >= 1 || steps >= 7) provider.tier = "VERIFIED";
    else provider.tier = "NEW";
  }
}

function updateCampaigns(world: SimWorld): void {
  for (const campaign of world.campaigns.values()) {
    if (campaign.status !== "ACTIVE") continue;
    if (world.step >= campaign.endStep) {
      campaign.status = "EXPIRED";
      // Remove incentive from offers using this asset.
      for (const offer of world.offers.values()) {
        if (offer.settlementAssetId === campaign.settlementAssetId) {
          offer.incentiveBps = 0;
          offer.version++;
        }
      }
    }
    // Check budget exhaustion.
    if (campaign.accrued >= campaign.totalBudget) {
      campaign.status = "EXHAUSTED";
      for (const offer of world.offers.values()) {
        if (offer.settlementAssetId === campaign.settlementAssetId) {
          offer.incentiveBps = 0;
          offer.version++;
        }
      }
    }
  }
}

function applyShocks(world: SimWorld, rng: SeededRNG): void {
  const config = world.config;
  if (!config.shockType || world.step !== config.shockStep) return;

  switch (config.shockType) {
    case "LIQUIDITY": {
      // Remove shockMagnitude fraction of liquidity.
      for (const offer of world.offers.values()) {
        offer.availableCapacity *= (1 - config.shockMagnitude);
        offer.version++;
      }
      break;
    }
    case "PROVIDER_EXIT": {
      // Remove the largest provider (by total volume).
      const activeProviders = [...world.providers.values()].filter(p => p.status === "ACTIVE");
      if (activeProviders.length > 0) {
        const largest = activeProviders.reduce((max, p) => p.totalVolume > max.totalVolume ? p : max, activeProviders[0]);
        largest.status = "EXITED";
        largest.exitStep = world.step;
        for (const offer of world.offers.values()) {
          if (offer.providerId === largest.id) offer.active = false;
        }
      }
      break;
    }
    case "ASSET_DEPEG": {
      // Degrade a settlement asset's peg quality.
      for (const asset of world.assets.values()) {
        if (asset.assetType === "STABLECOIN" && asset.pegQuality !== null) {
          asset.pegQuality *= (1 - config.shockMagnitude);
          asset.volatilityScore = Math.min(1, asset.volatilityScore + config.shockMagnitude * 0.3);
        }
      }
      break;
    }
    case "INCENTIVE_END": {
      // End all active campaigns.
      for (const campaign of world.campaigns.values()) {
        if (campaign.status === "ACTIVE") {
          campaign.status = "EXPIRED";
          for (const offer of world.offers.values()) {
            if (offer.settlementAssetId === campaign.settlementAssetId) {
              offer.incentiveBps = 0;
              offer.version++;
            }
          }
        }
      }
      break;
    }
    case "DEMAND_SURGE": {
      // Increase demand volume.
      world.config.demandVolume *= (1 + config.shockMagnitude);
      break;
    }
    case "REGULATORY": {
      // Suspend a random provider type.
      const suspendedType = rng.pick(["LOCAL_FIAT_AGENT", "PSP", "CEX", "DEX"]);
      for (const provider of world.providers.values()) {
        if (provider.providerType === suspendedType && provider.status === "ACTIVE") {
          provider.status = "SUSPENDED";
          for (const offer of world.offers.values()) {
            if (offer.providerId === provider.id) offer.active = false;
          }
        }
      }
      break;
    }
  }
}

function collectMetrics(world: SimWorld): SimMetrics {
  const intents = world.intents;
  const completed = intents.filter(i => i.status === "COMPLETED");
  const failed = intents.filter(i => i.status === "FAILED");
  const cancelled = intents.filter(i => i.status === "CANCELLED");
  const expired = intents.filter(i => i.status === "EXPIRED");
  const activeProviders = [...world.providers.values()].filter(p => p.status === "ACTIVE");
  const exitedProviders = [...world.providers.values()].filter(p => p.status === "EXITED");

  const costs = completed.map(i => i.effectiveCost / i.sourceAmount * 10000); // bps
  const avgCostBps = costs.length > 0 ? costs.reduce((s, c) => s + c, 0) / costs.length : 0;
  const waits = completed.map(i => i.waitedSteps);
  const avgWaitSteps = waits.length > 0 ? waits.reduce((s, w) => s + w, 0) / waits.length : 0;

  const executionSteps = completed.map(i => i.completedAtStep! - i.createdAtStep);
  executionSteps.sort((a, b) => a - b);
  const p50 = executionSteps.length > 0 ? executionSteps[Math.floor(executionSteps.length * 0.5)] : 0;
  const p95 = executionSteps.length > 0 ? executionSteps[Math.floor(executionSteps.length * 0.95)] : 0;

  const providerEarnings = activeProviders.map(p => p.totalEarnings);
  providerEarnings.sort((a, b) => a - b);
  const avgEarnings = providerEarnings.length > 0 ? providerEarnings.reduce((s, e) => s + e, 0) / providerEarnings.length : 0;
  const medianEarnings = providerEarnings.length > 0 ? providerEarnings[Math.floor(providerEarnings.length / 2)] : 0;

  const totalLiquidity = [...world.offers.values()].filter(o => o.active).reduce((s, o) => s + o.availableCapacity, 0);

  // Market concentration (HHI).
  const providerVolumes = activeProviders.map(p => p.totalVolume);
  const totalVol = providerVolumes.reduce((s, v) => s + v, 0);
  const hhi = totalVol > 0 ? providerVolumes.map(v => (v / totalVol) ** 2).reduce((s, h) => s + h, 0) : 1;

  // Equilibrium detection.
  let equilibriumStatus = "FORMING";
  if (activeProviders.length === 0) {
    equilibriumStatus = "NEGATIVE";
  } else if (world.step > 20) {
    const recentExits = exitedProviders.filter(p => p.exitStep !== null && p.exitStep > world.step - 20).length;
    const recentEntries = activeProviders.filter(p => p.entryStep > world.step - 20).length;
    if (recentExits > activeProviders.length * 0.3) {
      equilibriumStatus = "NEGATIVE";
    } else if (avgEarnings > 0 && activeProviders.length >= world.config.initialProviders) {
      equilibriumStatus = "POSITIVE";
    } else {
      equilibriumStatus = "FRAGILE";
    }
  }

  return {
    totalIntents: intents.length,
    completedIntents: completed.length,
    failedIntents: failed.length,
    cancelledIntents: cancelled.length,
    expiredIntents: expired.length,
    avgCostBps: Math.round(avgCostBps * 100) / 100,
    avgWaitSteps: Math.round(avgWaitSteps * 100) / 100,
    p50ExecutionSteps: p50,
    p95ExecutionSteps: p95,
    completionRate: intents.length > 0 ? Math.round((completed.length / intents.length) * 10000) / 100 : 0,
    activeProviders: activeProviders.length,
    exitedProviders: exitedProviders.length,
    avgProviderEarnings: Math.round(avgEarnings * 100) / 100,
    medianProviderEarnings: Math.round(medianEarnings * 100) / 100,
    avgUtilization: activeProviders.length > 0 ? Math.round((activeProviders.reduce((s, p) => s + p.utilization, 0) / activeProviders.length) * 10000) / 100 : 0,
    totalProviderVolume: Math.round(world.totalVolume * 100) / 100,
    totalProtocolRevenue: Math.round(world.totalFees * 100) / 100,
    totalIncentiveSpend: Math.round(world.totalIncentives * 100) / 100,
    totalLiquidity: Math.round(totalLiquidity * 100) / 100,
    avgRoutesPerCorridor: 0, // computed in API
    corridorCoverage: 0, // computed in API
    marketConcentration: Math.round(hhi * 10000) / 10000,
    equilibriumStatus,
  };
}

// Main simulation runner.
export function runSimulation(config: SimWorld["config"]): SimWorld {
  // Reset ID counters for reproducibility.
  intentCounter = 0;
  routeCounter = 0;

  const rng = new SeededRNG(config.seed);
  const world = createWorld(config);
  generateWorld(world, rng);

  for (let step = 0; step < config.totalSteps; step++) {
    simulateStep(world, rng);
  }

  // Final metrics.
  if (world.metricsHistory.length === 0 || world.metricsHistory[world.metricsHistory.length - 1] !== collectMetrics(world)) {
    world.metricsHistory.push(collectMetrics(world));
  }

  return world;
}
