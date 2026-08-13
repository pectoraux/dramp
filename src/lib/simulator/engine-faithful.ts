// dRamp Network Simulator — Faithful Engine (Prompt 4.1)
//
// Uses shared pure economics from src/lib/economics/shared.ts.
// No simplified second routing engine — route eligibility, scoring, risk,
// reputation, and economics all use the SAME functions as production.
//
// The simulation world remains entirely in-memory.

import { SeededRNG } from "./rng";
import {
  SimWorld, SimIntent, SimMetrics, SimProvider, SimOffer,
  SimCampaign, SimRoute,
} from "./world";
import { generateNewProvider } from "./generator";
import {
  weightFor, settlementAssetRisk, assetRiskCeiling, counterpartyRiskCeiling,
  isCollateralEligible, calculateAbsoluteRouteQuality, computeRouteReputation,
  computeRouteCommitment, shouldReplaceRoute, calculateReputation, deriveTier,
  calculateProviderEconomics, detectEquilibrium,
  type RouteInfo, type RouteScoreContext, type ReputationInput,
  type ProviderEconomicsInput,
} from "../economics/shared";

let intentCounter = 0;
let routeCounter = 0;

const MEANINGFUL_THRESHOLD = 50;
const VALUE_BASE = 100;
const DAY_MS = 86400000;

export function simulateStep(world: SimWorld, rng: SeededRNG): void {
  world.step++;
  world.timeMs += world.config.stepDurationMs;

  generateDemand(world, rng);
  matchAndExecute(world, rng);
  updateProviderOffers(world, rng);
  handleProviderEntryExit(world, rng);
  updateCampaigns(world);
  applyShocks(world, rng);
  if (world.step % 5 === 0 || world.step === world.config.totalSteps) {
    world.metricsHistory.push(collectMetrics(world));
  }
}

function generateDemand(world: SimWorld, rng: SeededRNG): void {
  const baseDemand = world.config.demandVolume * (1 + world.config.demandGrowth * world.step);
  const numIntents = Math.max(1, Math.round(baseDemand * rng.float(0.7, 1.3)));
  for (let i = 0; i < numIntents; i++) {
    const activeUsers = [...world.users.values()];
    if (activeUsers.length === 0) break;
    const user = rng.pick(activeUsers);
    if (!rng.chance(user.frequency)) continue;
    const amount = Math.max(10, rng.gaussian(user.typicalAmount, user.amountStdDev));
    world.intents.push({
      id: `intent_${++intentCounter}`, userId: user.id, sourceAmount: amount,
      sourceAsset: user.sourceAsset, sourceCountry: user.sourceCountry,
      destinationAsset: user.destinationAsset, destinationCountry: user.destinationCountry,
      riskTolerance: user.riskTolerance, executionPolicy: user.executionPolicy,
      maxWaitSeconds: user.maxWaitSeconds, status: "SEARCHING",
      createdAtStep: world.step, completedAtStep: null, selectedRouteId: null,
      routeTag: null, effectiveCost: 0, netOutput: 0, waitedSteps: 0, failureReason: null,
    });
  }
}

interface SimCandidateRoute {
  legs: Array<{ providerId: string; providerName: string; sourceAsset: string; destinationAsset: string;
    feeBps: number; rate: number; channelType: string; amount: number; role: string;
    sourceCountry: string; destinationCountry: string; }>;
  effectiveCost: number; netOutput: number; expectedExecutionSeconds: number;
  riskComposite: number; tag: string; explanation: string;
  settlementAssetIds: string[];
}

function matchAndExecute(world: SimWorld, rng: SeededRNG): void {
  // Build reputation map from sim providers (using shared reputation calculation).
  const reputationMap = buildReputationMap(world);
  const corridorScoreMap = buildCorridorScoreMap(world);
  const commitmentReliabilityMap = buildCommitmentReliabilityMap(world);
  const scoreCtx: RouteScoreContext = {
    riskTolerance: "BALANCED", // will be overridden per-intent
    reputationMap: world.config.enableReputation ? reputationMap : undefined,
    corridorScores: world.config.enableReputation ? corridorScoreMap : undefined,
    commitmentReliability: world.config.enableCommitments ? commitmentReliabilityMap : undefined,
  };

  for (const intent of world.intents) {
    if (intent.status !== "SEARCHING") continue;

    const routes = findRoutesFaithful(world, intent, rng);
    if (routes.length === 0) {
      intent.waitedSteps++;
      const maxWaitSteps = Math.ceil(intent.maxWaitSeconds / (world.config.stepDurationMs / 1000));
      if (intent.waitedSteps > maxWaitSteps) {
        intent.status = "EXPIRED";
        intent.failureReason = "no route found within max wait";
      }
      continue;
    }

    // Score routes using SHARED calculateAbsoluteRouteQuality.
    scoreCtx.riskTolerance = intent.riskTolerance;
    const scored = routes.map(r => {
      const routeInfo: RouteInfo = {
        legs: r.legs.map(l => ({
          providerId: l.providerId, sourceAsset: l.sourceAsset, destinationAsset: l.destinationAsset,
          sourceCountry: l.sourceCountry, destinationCountry: l.destinationCountry,
          role: l.role, amount: l.amount,
        })),
        effectiveCost: r.effectiveCost,
        expectedExecutionSeconds: r.expectedExecutionSeconds,
        riskComposite: r.riskComposite,
      };
      return { route: r, quality: calculateAbsoluteRouteQuality(routeInfo, scoreCtx) };
    });
    scored.sort((a, b) => a.quality - b.quality); // lower = better
    const best = scored[0].route;

    // Patient execution: WAIT_FOR_BETTER doesn't immediately execute.
    if (intent.executionPolicy === "WAIT_FOR_BETTER") {
      // Check if we already have a reference route.
      if (intent.selectedRouteId) {
        const refRoute = world.routes.get(intent.selectedRouteId);
        if (refRoute) {
          const refInfo: RouteInfo = {
            legs: refRoute.legs.map(l => ({
              providerId: l.providerId, sourceAsset: l.sourceAsset, destinationAsset: l.destinationAsset,
              sourceCountry: "", destinationCountry: "", role: "SOURCE", amount: intent.sourceAmount,
            })),
            effectiveCost: intent.effectiveCost,
            expectedExecutionSeconds: refRoute.expectedExecutionSeconds,
            riskComposite: refRoute.riskComposite,
          };
          const bestInfo: RouteInfo = {
            legs: best.legs.map(l => ({
              providerId: l.providerId, sourceAsset: l.sourceAsset, destinationAsset: l.destinationAsset,
              sourceCountry: l.sourceCountry, destinationCountry: l.destinationCountry,
              role: l.role, amount: l.amount,
            })),
            effectiveCost: best.effectiveCost,
            expectedExecutionSeconds: best.expectedExecutionSeconds,
            riskComposite: best.riskComposite,
          };
          const replacement = shouldReplaceRoute(bestInfo, refInfo, scoreCtx);
          if (replacement.replace) {
            // Replace reference with the better route and execute.
            executeIntent(world, intent, { ...best, id: `route_${++routeCounter}` }, rng);
          } else {
            // Keep waiting.
            intent.waitedSteps++;
            const maxWaitSteps = Math.ceil(intent.maxWaitSeconds / (world.config.stepDurationMs / 1000));
            if (intent.waitedSteps > maxWaitSteps) {
              // Timeout — execute the current reference.
              executeIntent(world, intent, { ...best, id: intent.selectedRouteId }, rng);
            }
          }
          continue;
        }
      }
      // No reference yet — set initial reference (don't execute yet).
      const routeId = `route_${++routeCounter}`;
      world.routes.set(routeId, {
        id: routeId, intentId: intent.id, tag: best.tag,
        legs: best.legs, effectiveCost: best.effectiveCost, netOutput: best.netOutput,
        expectedExecutionSeconds: best.expectedExecutionSeconds, riskComposite: best.riskComposite,
        explanation: best.explanation,
      });
      intent.selectedRouteId = routeId;
      intent.routeTag = best.tag;
      intent.effectiveCost = best.effectiveCost;
      intent.netOutput = best.netOutput;
      intent.waitedSteps++;
      continue;
    }

    // NOW policy — execute immediately.
    executeIntent(world, intent, { ...best, id: `route_${++routeCounter}` }, rng);
  }
}

function findRoutesFaithful(world: SimWorld, intent: SimIntent, rng: SeededRNG): SimCandidateRoute[] {
  const routes: SimCandidateRoute[] = [];
  const providers = world.providers;
  const assets = world.assets;
  const riskCeiling = assetRiskCeiling(intent.riskTolerance);
  const cpRiskCeiling = counterpartyRiskCeiling(intent.riskTolerance);

  // Direct routes.
  for (const offer of world.offers.values()) {
    if (!offer.active) continue;
    if (offer.sourceAsset !== intent.sourceAsset || offer.destinationAsset !== intent.destinationAsset) continue;
    const provider = providers.get(offer.providerId);
    if (!provider || provider.status !== "ACTIVE") continue;
    if (offer.availableCapacity - offer.reservedCapacity < intent.sourceAmount) continue;

    // Check settlement asset risk against user's ceiling.
    if (offer.settlementAssetId) {
      const sa = assets.get(offer.settlementAssetId);
      if (sa) {
        const saRisk = settlementAssetRisk({
          assetType: sa.assetType, volatilityScore: sa.volatilityScore,
          liquidityScore: sa.liquidityScore, pegQuality: sa.pegQuality,
          status: sa.status, incentiveRate: sa.incentiveRate,
        });
        if (saRisk > riskCeiling) continue; // hard filter
      }
    }

    // Check counterparty risk.
    const cpRisk = 1 - provider.reputationScore;
    if (cpRisk > cpRiskCeiling) continue; // hard filter

    const fee = intent.sourceAmount * offer.feeBps / 10000;
    const afterFee = intent.sourceAmount - fee;
    const converted = afterFee * offer.rate;
    const incentive = converted * offer.incentiveBps / 10000;
    const netOutput = converted + incentive;
    routes.push({
      legs: [{ providerId: provider.id, providerName: provider.name, sourceAsset: offer.sourceAsset,
        destinationAsset: offer.destinationAsset, feeBps: offer.feeBps, rate: offer.rate,
        channelType: offer.channelType, amount: intent.sourceAmount, role: "SOURCE",
        sourceCountry: offer.sourceCountry, destinationCountry: offer.destinationCountry }],
      effectiveCost: fee, netOutput, expectedExecutionSeconds: offer.expectedExecutionSeconds,
      riskComposite: cpRisk, tag: "DIRECT", explanation: `Direct via ${provider.name}`,
      settlementAssetIds: offer.settlementAssetId ? [offer.settlementAssetId] : [],
    });
  }

  // Multi-hop routes via ALL settlement assets (INCLUDING volatile tokens).
  for (const sa of assets.values()) {
    if (sa.status !== "ACTIVE") continue;
    // NO exclusion of VOLATILE_TOKEN — the risk ceiling handles eligibility.
    const saRisk = settlementAssetRisk({
      assetType: sa.assetType, volatilityScore: sa.volatilityScore,
      liquidityScore: sa.liquidityScore, pegQuality: sa.pegQuality,
      status: sa.status, incentiveRate: sa.incentiveRate,
    });
    if (saRisk > riskCeiling) continue; // hard filter on the settlement asset

    const hop1Offers = [...world.offers.values()].filter(o =>
      o.active && o.sourceAsset === intent.sourceAsset && o.destinationAsset === sa.symbol
    );
    const hop2Offers = [...world.offers.values()].filter(o =>
      o.active && o.sourceAsset === sa.symbol && o.destinationAsset === intent.destinationAsset
    );

    for (const o1 of hop1Offers) {
      const p1 = providers.get(o1.providerId);
      if (!p1 || p1.status !== "ACTIVE") continue;
      const cpRisk1 = 1 - p1.reputationScore;
      if (cpRisk1 > cpRiskCeiling) continue;

      for (const o2 of hop2Offers) {
        const p2 = providers.get(o2.providerId);
        if (!p2 || p2.status !== "ACTIVE") continue;
        const cpRisk2 = 1 - p2.reputationScore;
        if (cpRisk2 > cpRiskCeiling) continue;

        const fee1 = intent.sourceAmount * o1.feeBps / 10000;
        const afterFee1 = intent.sourceAmount - fee1;
        const midAmount = afterFee1 * o1.rate;
        const fee2 = midAmount * o2.feeBps / 10000;
        const afterFee2 = midAmount - fee2;
        const finalAmount = afterFee2 * o2.rate;
        const incentive = finalAmount * (o1.incentiveBps + o2.incentiveBps) / 10000;
        const netOutput = finalAmount + incentive;
        const effectiveCost = fee1 + fee2;
        const avgRisk = (cpRisk1 + cpRisk2) / 2;
        const minRisk = Math.min(cpRisk1, cpRisk2);
        const routeRisk = avgRisk * 0.7 + minRisk * 0.3; // weakest-leg penalty

        routes.push({
          legs: [
            { providerId: p1.id, providerName: p1.name, sourceAsset: o1.sourceAsset, destinationAsset: o1.destinationAsset,
              feeBps: o1.feeBps, rate: o1.rate, channelType: o1.channelType, amount: intent.sourceAmount, role: "SOURCE",
              sourceCountry: o1.sourceCountry, destinationCountry: o1.destinationCountry },
            { providerId: p2.id, providerName: p2.name, sourceAsset: o2.sourceAsset, destinationAsset: o2.destinationAsset,
              feeBps: o2.feeBps, rate: o2.rate, channelType: o2.channelType, amount: midAmount, role: "DESTINATION",
              sourceCountry: o2.sourceCountry, destinationCountry: o2.destinationCountry },
          ],
          effectiveCost, netOutput,
          expectedExecutionSeconds: Math.max(o1.expectedExecutionSeconds, o2.expectedExecutionSeconds),
          riskComposite: routeRisk, tag: "MULTI_HOP",
          explanation: `Multi-hop via ${sa.symbol}: ${p1.name} → ${p2.name}`,
          settlementAssetIds: [sa.id],
        });
      }
    }
  }

  return routes;
}

function executeIntent(world: SimWorld, intent: SimIntent, route: SimCandidateRoute & { id: string }, rng: SeededRNG): void {
  const provider = world.providers.get(route.legs[0].providerId);
  if (!provider) { intent.status = "FAILED"; intent.failureReason = "provider not found"; return; }

  // Failure model based on reputation.
  const failureRate = (1 - provider.reputationScore) * 0.1;
  if (rng.chance(failureRate)) {
    intent.status = "FAILED";
    intent.failureReason = "provider execution failure";
    provider.executionsFailed++;
    provider.totalPenalties += intent.sourceAmount * 0.001;
    return;
  }

  intent.status = "COMPLETED";
  intent.completedAtStep = world.step;
  intent.effectiveCost = route.effectiveCost;
  intent.netOutput = route.netOutput;
  intent.waitedSteps = world.step - intent.createdAtStep;
  intent.selectedRouteId = route.id;
  intent.routeTag = route.tag;

  // Update provider economics using shared calculateProviderEconomics.
  for (const leg of route.legs) {
    const p = world.providers.get(leg.providerId);
    if (!p) continue;
    const fee = leg.amount * leg.feeBps / 10000;
    const incentive = route.netOutput * (route.legs.length > 0 ? 0 : 0); // incentive is embedded in netOutput
    p.totalVolume += leg.amount;
    p.totalEarnings += fee;
    p.executionsCompleted++;
    p.reputationScore = Math.min(1.0, p.reputationScore + 0.001);
  }

  // Accrue incentives on completed executions.
  for (const saId of route.settlementAssetIds) {
    for (const campaign of world.campaigns.values()) {
      if (campaign.status !== "ACTIVE") continue;
      if (campaign.settlementAssetId === saId) {
        const inc = route.netOutput * campaign.incentiveBps / 10000;
        const remaining = campaign.totalBudget - campaign.accrued;
        if (remaining > 0) {
          const actualInc = Math.min(inc, remaining);
          campaign.accrued += actualInc;
          world.totalIncentives += actualInc;
          // Distribute to providers.
          for (const leg of route.legs) {
            const p = world.providers.get(leg.providerId);
            if (p) p.totalIncentives += actualInc / route.legs.length;
          }
        }
      }
    }
  }

  world.totalVolume += intent.sourceAmount;
  world.totalFees += route.effectiveCost;
}

function updateProviderOffers(world: SimWorld, rng: SeededRNG): void {
  for (const offer of world.offers.values()) {
    const provider = world.providers.get(offer.providerId);
    if (!provider || provider.status !== "ACTIVE" || !offer.active) continue;
    const utilization = offer.availableCapacity > 0 ? offer.reservedCapacity / offer.availableCapacity : 0;
    provider.utilization = utilization;

    // Strategy-based pricing (same as before, but now economics-aware).
    const netEarningsPerStep = provider.totalEarnings / Math.max(1, world.step - provider.entryStep);
    const capitalEfficiency = netEarningsPerStep / Math.max(1, provider.usableCollateral);
    const isProfitable = capitalEfficiency > world.config.providerExitThreshold;

    switch (provider.strategy) {
      case "AGGRESSIVE":
        if (utilization < 0.3 && rng.chance(0.1)) offer.feeBps = Math.max(3, offer.feeBps - 1);
        if (utilization > 0.7 && rng.chance(0.1)) offer.feeBps += 1;
        break;
      case "PREMIUM":
        if (utilization > 0.8 && rng.chance(0.05)) offer.availableCapacity *= 1.1;
        break;
      case "LIQUIDITY_MAXIMIZER":
        if (utilization < 0.2 && rng.chance(0.15)) offer.feeBps = Math.max(5, offer.feeBps - 2);
        break;
      case "MARKET_MAKER":
        if (rng.chance(0.1)) offer.rate *= rng.float(0.99, 1.01);
        break;
      case "INCENTIVE_SEEKER":
        if (offer.incentiveBps === 0 && rng.chance(0.05)) {
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
        if (provider.reputationScore < 0.6 && rng.chance(0.1)) offer.availableCapacity *= 0.9;
        break;
      case "OPPORTUNISTIC":
        if (utilization > 0.6 && rng.chance(0.1)) offer.feeBps += 2;
        if (utilization < 0.2 && rng.chance(0.1)) offer.feeBps = Math.max(5, offer.feeBps - 2);
        break;
    }

    if (rng.chance(0.05)) offer.rate *= rng.float(0.995, 1.005);
    offer.version++;
  }
}

function handleProviderEntryExit(world: SimWorld, rng: SeededRNG): void {
  // Entry.
  if (rng.chance(world.config.providerGrowthRate)) {
    generateNewProvider(world, rng, world.step);
  }

  // Exit based on risk-adjusted return (not just raw earnings).
  const networkMedianFee = calculateNetworkMedianFee(world);
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const steps = world.step - provider.entryStep;
    if (steps < 10) continue;

    // Calculate provider economics using shared function.
    const econ = calculateProviderEconomics({
      grossFees: provider.totalEarnings,
      incentives: provider.totalIncentives,
      rebates: 0,
      settlementCosts: provider.totalVolume * 0.0001, // 1 bps settlement cost
      operatingCosts: provider.totalVolume * 0.0002,  // 2 bps operating cost
      capitalCostRate: 0.05, // 5% annual
      averageDeployedCapital: provider.usableCollateral,
      expectedLossRate: 0.001, // 10 bps
      penalties: provider.totalPenalties,
      slashing: provider.totalSlashing,
      stepsPerYear: (365 * 24 * 3600 * 1000) / world.config.stepDurationMs,
    });

    // Exit if risk-adjusted return is negative.
    if (econ.riskAdjustedReturn < 0 && rng.chance(0.1)) {
      provider.status = "EXITED";
      provider.exitStep = world.step;
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

  // Update tiers using shared deriveTier.
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const steps = world.step - provider.entryStep;
    const ageDays = (steps * world.config.stepDurationMs) / DAY_MS;
    const repInput = buildReputationInput(provider, ageDays, networkMedianFee);
    const rep = calculateReputation(repInput);
    provider.reputationScore = rep.overall / 100;
    provider.tier = deriveTier(rep.overall, rep.sampleSize, ageDays, 0);
  }
}

function updateCampaigns(world: SimWorld): void {
  for (const campaign of world.campaigns.values()) {
    if (campaign.status !== "ACTIVE") continue;
    if (world.step >= campaign.endStep) {
      campaign.status = "EXPIRED";
      for (const offer of world.offers.values()) {
        if (offer.settlementAssetId === campaign.settlementAssetId) {
          offer.incentiveBps = 0;
          offer.version++;
        }
      }
    }
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
    case "LIQUIDITY":
      for (const offer of world.offers.values()) {
        offer.availableCapacity *= (1 - config.shockMagnitude);
        offer.version++;
      }
      break;
    case "PROVIDER_EXIT": {
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
    case "ASSET_DEPEG":
      for (const asset of world.assets.values()) {
        if (asset.assetType === "STABLECOIN" && asset.pegQuality !== null) {
          asset.pegQuality *= (1 - config.shockMagnitude);
          asset.volatilityScore = Math.min(1, asset.volatilityScore + config.shockMagnitude * 0.3);
        }
      }
      break;
    case "INCENTIVE_END":
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
    case "DEMAND_SURGE":
      world.config.demandVolume *= (1 + config.shockMagnitude);
      break;
    case "REGULATORY": {
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
  const expired = intents.filter(i => i.status === "EXPIRED");
  const activeProviders = [...world.providers.values()].filter(p => p.status === "ACTIVE");
  const exitedProviders = [...world.providers.values()].filter(p => p.status === "EXITED");

  const costs = completed.map(i => i.effectiveCost / i.sourceAmount * 10000);
  const avgCostBps = costs.length > 0 ? costs.reduce((s, c) => s + c, 0) / costs.length : 0;
  const waits = completed.map(i => i.waitedSteps);
  const avgWaitSteps = waits.length > 0 ? waits.reduce((s, w) => s + w, 0) / waits.length : 0;

  const executionSteps = completed.map(i => i.completedAtStep! - i.createdAtStep);
  executionSteps.sort((a, b) => a - b);
  const p50 = executionSteps.length > 0 ? executionSteps[Math.floor(executionSteps.length * 0.5)] : 0;
  const p95 = executionSteps.length > 0 ? executionSteps[Math.floor(executionSteps.length * 0.95)] : 0;

  // Provider economics using shared function.
  const providerEcons = activeProviders.map(p => {
    return calculateProviderEconomics({
      grossFees: p.totalEarnings, incentives: p.totalIncentives, rebates: 0,
      settlementCosts: p.totalVolume * 0.0001, operatingCosts: p.totalVolume * 0.0002,
      capitalCostRate: 0.05, averageDeployedCapital: p.usableCollateral,
      expectedLossRate: 0.001, penalties: p.totalPenalties, slashing: p.totalSlashing,
      stepsPerYear: (365 * 24 * 3600 * 1000) / world.config.stepDurationMs,
    });
  });
  const returns = providerEcons.map(e => e.riskAdjustedReturn).sort((a, b) => a - b);
  const medianReturn = returns.length > 0 ? returns[Math.floor(returns.length / 2)] : 0;
  const avgEarnings = providerEcons.length > 0 ? providerEcons.reduce((s, e) => s + e.netEarnings, 0) / providerEcons.length : 0;

  const totalLiquidity = [...world.offers.values()].filter(o => o.active).reduce((s, o) => s + o.availableCapacity, 0);
  const providerVolumes = activeProviders.map(p => p.totalVolume);
  const totalVol = providerVolumes.reduce((s, v) => s + v, 0);
  const hhi = totalVol > 0 ? providerVolumes.map(v => (v / totalVol) ** 2).reduce((s, h) => s + h, 0) : 1;

  // Route coverage: fraction of intents that found a route.
  const routeCoverage = intents.length > 0 ? (completed.length + intents.filter(i => i.status === "EXECUTING").length) / intents.length : 0;

  // Equilibrium using shared detectEquilibrium.
  const recentExits = exitedProviders.filter(p => p.exitStep !== null && p.exitStep > world.step - 20).length;
  const recentEntries = activeProviders.filter(p => p.entryStep > world.step - 20).length;
  const activeIncentives = [...world.campaigns.values()].filter(c => c.status === "ACTIVE").length;
  const incentiveDependent = activeIncentives > 0 && world.totalIncentives > world.totalFees * 0.1;

  // Check stability: compare last 3 metrics points.
  const stable = world.metricsHistory.length >= 3
    ? Math.abs((world.metricsHistory[world.metricsHistory.length - 1].avgCostBps - world.metricsHistory[world.metricsHistory.length - 3].avgCostBps)) < 50
    : false;

  const eqResult = detectEquilibrium({
    medianRiskAdjustedReturn: medianReturn,
    providerEntryRate: recentEntries / 20,
    providerExitRate: recentExits / 20,
    routeCoverage,
    avgCostBps,
    baselineCostBps: world.config.baselineCostBps,
    marketConcentration: hhi,
    incentiveDependent,
    recentSteps: world.step,
    stableReturns: stable,
  });

  return {
    totalIntents: intents.length, completedIntents: completed.length,
    failedIntents: failed.length, cancelledIntents: 0, expiredIntents: expired.length,
    avgCostBps: Math.round(avgCostBps * 100) / 100, avgWaitSteps: Math.round(avgWaitSteps * 100) / 100,
    p50ExecutionSteps: p50, p95ExecutionSteps: p95,
    completionRate: intents.length > 0 ? Math.round((completed.length / intents.length) * 10000) / 100 : 0,
    activeProviders: activeProviders.length, exitedProviders: exitedProviders.length,
    avgProviderEarnings: Math.round(avgEarnings * 100) / 100,
    medianProviderEarnings: providerEcons.length > 0 ? Math.round(providerEcons[Math.floor(providerEcons.length / 2)].netEarnings * 100) / 100 : 0,
    avgUtilization: activeProviders.length > 0 ? Math.round((activeProviders.reduce((s, p) => s + p.utilization, 0) / activeProviders.length) * 10000) / 100 : 0,
    totalProviderVolume: Math.round(world.totalVolume * 100) / 100,
    totalProtocolRevenue: Math.round(world.totalFees * 100) / 100,
    totalIncentiveSpend: Math.round(world.totalIncentives * 100) / 100,
    totalLiquidity: Math.round(totalLiquidity * 100) / 100,
    avgRoutesPerCorridor: 0, corridorCoverage: 0,
    marketConcentration: Math.round(hhi * 10000) / 10000,
    equilibriumStatus: eqResult.status,
  };
}

// ---- Helpers ----

function buildReputationMap(world: SimWorld): Map<string, number> {
  const map = new Map<string, number>();
  const networkMedianFee = calculateNetworkMedianFee(world);
  for (const p of world.providers.values()) {
    if (p.status !== "ACTIVE") continue;
    const ageDays = ((world.step - p.entryStep) * world.config.stepDurationMs) / DAY_MS;
    const repInput = buildReputationInput(p, ageDays, networkMedianFee);
    const rep = calculateReputation(repInput);
    map.set(p.id, rep.overall / 100);
  }
  return map;
}

function buildReputationInput(p: SimProvider, ageDays: number, networkMedianFee: number): ReputationInput {
  // Simplified weighting for the simulator (no per-leg recency tracking).
  const total = p.executionsCompleted + p.executionsFailed;
  return {
    completed: p.executionsCompleted,
    failed: p.executionsFailed,
    cancelled: 0,
    disputes: 0,
    slashes: 0,
    avgDurationSeconds: 60, // default
    utilization: p.utilization,
    medianFeeBps: 20, // approximate
    networkMedianFeeBps: networkMedianFee,
    ageDays,
    weightedCompleted: p.executionsCompleted,
    weightedFailed: p.executionsFailed,
    weightedCancelled: 0,
    weightedDisputes: 0,
    weightedSlashes: 0,
    meaningfulExecutions: p.executionsCompleted,
  };
}

function buildCorridorScoreMap(world: SimWorld): Map<string, number> {
  // Simplified: use provider reputation as corridor score for now.
  return new Map();
}

function buildCommitmentReliabilityMap(world: SimWorld): Map<string, number> {
  // Simplified: return empty (no commitment simulation yet).
  return new Map();
}

function calculateNetworkMedianFee(world: SimWorld): number {
  const fees = [...world.offers.values()].filter(o => o.active).map(o => o.feeBps).sort((a, b) => a - b);
  return fees.length > 0 ? fees[Math.floor(fees.length / 2)] : 20;
}

// Main simulation runner.
import { createWorld } from "./world";
import { generateWorld } from "./generator";

export function runSimulation(config: SimWorld["config"]): SimWorld {
  intentCounter = 0;
  routeCounter = 0;
  const rng = new SeededRNG(config.seed);
  const world = createWorld(config);
  generateWorld(world, rng);
  for (let step = 0; step < config.totalSteps; step++) {
    simulateStep(world, rng);
  }
  if (world.metricsHistory.length === 0) {
    world.metricsHistory.push(collectMetrics(world));
  }
  return world;
}
