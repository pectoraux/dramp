// dRamp Network Simulator — Faithful Engine (Prompt 4.2)
//
// Uses the SAME canonical pure economic functions as production
// (src/lib/economics/shared.ts). No second economic engine.
//
// Key faithfulness guarantees:
//   1. Initial route selection uses shared.rankRoutes (candidate-set-relative),
//      matching production's rankAndTag semantics — NOT calculateAbsoluteRouteQuality.
//   2. Cross-time route replacement (WAIT_FOR_BETTER) uses shared.shouldReplaceRoute
//      (absolute quality), matching production's advanceSearching.
//   3. Route risk uses shared.computeRouteRisk (5 dimensions + composite).
//   4. Counterparty risk uses shared.providerCounterpartyRisk.
//   5. Settlement-asset risk uses shared.settlementAssetRisk + assetRiskCeiling.
//   6. Reputation is RECALCULATED from per-execution history using
//      shared.calculateReputation (7 components, recency + value weighting,
//      anti-gaming) — NOT reputationScore += 0.001.
//   7. Provider P&L uses shared.calculateProviderEconomics (fees + incentives
//      + rebates − settlement costs − operating costs − capital cost − expected
//      loss − penalties − slashing = net; risk-adjusted return).
//   8. Provider exit uses shared risk-adjusted return (negative → exit).
//   9. Equilibrium uses shared.detectEquilibrium (economic thresholds).

import { SeededRNG } from "./rng";
import {
  SimWorld, SimIntent, SimMetrics, SimProvider, SimOffer,
  SimCampaign, SimRoute, SimExecutionRecord,
} from "./world";
import { generateNewProvider } from "./generator";
import {
  weightFor,
  settlementAssetRisk,
  providerCounterpartyRisk,
  computeRouteRisk,
  assetRiskCeiling,
  counterpartyRiskCeiling,
  isCollateralEligible,
  calculateAbsoluteRouteQuality,
  computeRouteReputation,
  computeRouteCommitment,
  shouldReplaceRoute,
  rankRoutes,
  applyHardFilters,
  calculateReputation,
  deriveTier,
  calculateProviderEconomics,
  detectEquilibrium,
  decayWeight,
  valueWeight,
  MEANINGFUL_THRESHOLD,
  ROUTE_REPLACEMENT_THRESHOLD,
  type RouteInfo,
  type RouteLegInfo,
  type RouteScoreContext,
  type ReputationInput,
  type ProviderEconomicsInput,
  type ProviderRiskInfo,
  type SettlementAssetRiskInput,
  type HardFilterContext,
  type RankedRoute,
} from "../economics/shared";

let intentCounter = 0;
let routeCounter = 0;

const DAY_MS = 86400000;

// Economic parameters — shared with production (see provider-economics.ts).
const CAPITAL_COST_RATE_ANNUAL = 0.05;
const EXPECTED_LOSS_RATE = 0.001;
const SETTLEMENT_COST_BPS = 1;
const OPERATING_COST_BPS = 2;

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

// ---- Candidate route type (enriched with risk inputs for shared functions) --

interface SimCandidateRoute {
  legs: Array<{
    providerId: string;
    providerName: string;
    sourceAsset: string;
    destinationAsset: string;
    sourceCountry: string;
    destinationCountry: string;
    feeBps: number;
    rate: number;
    channelType: string;
    amount: number;
    role: string;
    expectedExecutionSeconds: number;
    offerCapacity: number;
    settlementAssetId: string | null;
    providerRisk: ProviderRiskInfo;
    settlementAssetRisk: SettlementAssetRiskInput | null;
  }>;
  effectiveCost: number;
  netOutput: number;
  expectedExecutionSeconds: number;
  riskComposite: number;
  tag: string;
  explanation: string;
  settlementAssetIds: string[];
}

// ---- SimCandidateRoute → shared RouteInfo conversion -----------------------

function simCandidateToRouteInfo(route: SimCandidateRoute): RouteInfo {
  return {
    legs: route.legs.map((l): RouteLegInfo => ({
      providerId: l.providerId,
      sourceAsset: l.sourceAsset,
      destinationAsset: l.destinationAsset,
      sourceCountry: l.sourceCountry,
      destinationCountry: l.destinationCountry,
      role: l.role,
      amount: l.amount,
      feeBps: l.feeBps,
      channelType: l.channelType,
      offerCapacity: l.offerCapacity,
      expectedExecutionSeconds: l.expectedExecutionSeconds,
      settlementAssetId: l.settlementAssetId,
      provider: l.providerRisk,
      settlementAsset: l.settlementAssetRisk ?? undefined,
    })),
    effectiveCost: route.effectiveCost,
    expectedExecutionSeconds: route.expectedExecutionSeconds,
    riskComposite: route.riskComposite,
  };
}

// ---- Match + execute ------------------------------------------------------

function matchAndExecute(world: SimWorld, rng: SeededRNG): void {
  // Build reputation + corridor + commitment maps using shared calculations.
  const reputationMap = buildReputationMap(world);
  const corridorScoreMap = buildCorridorScoreMap(world);
  const commitmentReliabilityMap = buildCommitmentReliabilityMap(world);
  const baseScoreCtx: RouteScoreContext = {
    riskTolerance: "BALANCED", // overridden per-intent
    reputationMap: world.config.enableReputation ? reputationMap : undefined,
    corridorScores: world.config.enableReputation ? corridorScoreMap : undefined,
    commitmentReliability: world.config.enableCommitments ? commitmentReliabilityMap : undefined,
  };

  for (const intent of world.intents) {
    if (intent.status !== "SEARCHING") continue;

    const routes = findRoutesFaithful(world, intent);
    if (routes.length === 0) {
      intent.waitedSteps++;
      const maxWaitSteps = Math.ceil(intent.maxWaitSeconds / (world.config.stepDurationMs / 1000));
      if (intent.waitedSteps > maxWaitSteps) {
        intent.status = "EXPIRED";
        intent.failureReason = "no route found within max wait";
      }
      continue;
    }

    // INITIAL SELECTION: use shared.rankRoutes (candidate-set-relative),
    // matching production's rankAndTag semantics.
    const scoreCtx: RouteScoreContext = { ...baseScoreCtx, riskTolerance: intent.riskTolerance };
    const routeInfos = routes.map(r => simCandidateToRouteInfo(r));
    const ranked: RankedRoute[] = rankRoutes(routeInfos, scoreCtx);
    const best = routes[routeInfos.indexOf(ranked[0].route)];

    // Patient execution: WAIT_FOR_BETTER doesn't immediately execute.
    if (intent.executionPolicy === "WAIT_FOR_BETTER") {
      if (intent.selectedRouteId) {
        const refRoute = world.routes.get(intent.selectedRouteId);
        if (refRoute) {
          // CROSS-TIME REPLACEMENT: use shared.shouldReplaceRoute (absolute quality).
          const refInfo = reconstructRefRouteInfo(intent, refRoute, scoreCtx);
          const bestInfo = simCandidateToRouteInfo(best);
          const replacement = shouldReplaceRoute(bestInfo, refInfo, scoreCtx);
          if (replacement.replace) {
            executeIntent(world, intent, { ...best, id: `route_${++routeCounter}` }, rng);
          } else {
            intent.waitedSteps++;
            const maxWaitSteps = Math.ceil(intent.maxWaitSeconds / (world.config.stepDurationMs / 1000));
            if (intent.waitedSteps > maxWaitSteps) {
              // Timeout — execute the current reference route.
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
        legs: best.legs.map(l => ({
          providerId: l.providerId, providerName: l.providerName,
          sourceAsset: l.sourceAsset, destinationAsset: l.destinationAsset,
          feeBps: l.feeBps, rate: l.rate, channelType: l.channelType, amount: l.amount,
        })),
        effectiveCost: best.effectiveCost, netOutput: best.netOutput,
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

// Reconstruct a RouteInfo for a persisted reference route (for WAIT_FOR_BETTER
// comparison). Uses the intent's source amount and the ref route's economics.
function reconstructRefRouteInfo(
  intent: SimIntent,
  refRoute: SimRoute,
  ctx: RouteScoreContext,
): RouteInfo {
  // Build leg info from the persisted SimRoute. We don't have full risk inputs
  // for historical legs, so we use the route's composite risk directly.
  const legs: RouteLegInfo[] = refRoute.legs.map(l => ({
    providerId: l.providerId,
    sourceAsset: l.sourceAsset,
    destinationAsset: l.destinationAsset,
    sourceCountry: "",
    destinationCountry: "",
    role: "SOURCE",
    amount: l.amount,
    feeBps: l.feeBps,
    channelType: l.channelType,
    offerCapacity: 0,
    expectedExecutionSeconds: refRoute.expectedExecutionSeconds,
    provider: { trustModel: "NON_CUSTODIAL", providerType: "HYBRID", reputationScore: 0.5, status: "ACTIVE" },
  }));
  return {
    legs,
    effectiveCost: intent.effectiveCost,
    expectedExecutionSeconds: refRoute.expectedExecutionSeconds,
    riskComposite: refRoute.riskComposite,
  };
}

// ---- Route discovery (direct + multi-hop via ALL settlement assets) --------

function findRoutesFaithful(world: SimWorld, intent: SimIntent): SimCandidateRoute[] {
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

    const providerRisk: ProviderRiskInfo = {
      trustModel: provider.trustModel,
      providerType: provider.providerType,
      reputationScore: provider.reputationScore,
      status: provider.status,
    };

    let saRiskInput: SettlementAssetRiskInput | null = null;
    if (offer.settlementAssetId) {
      const sa = assets.get(offer.settlementAssetId);
      if (sa) {
        saRiskInput = {
          assetType: sa.assetType, volatilityScore: sa.volatilityScore,
          liquidityScore: sa.liquidityScore, pegQuality: sa.pegQuality,
          status: sa.status, incentiveRate: sa.incentiveRate,
        };
        const saRisk = settlementAssetRisk(saRiskInput);
        if (saRisk > riskCeiling) continue; // hard filter
      }
    }

    // Counterparty risk using shared function.
    const cpRisk = providerCounterpartyRisk(providerRisk);
    if (cpRisk > cpRiskCeiling) continue; // hard filter

    // Compute route risk using shared computeRouteRisk.
    const routeRisk = computeRouteRisk([{
      provider: providerRisk,
      channelType: offer.channelType,
      offerCapacity: offer.availableCapacity,
      legAmount: intent.sourceAmount,
      settlementAsset: saRiskInput ?? undefined,
      expectedExecutionSeconds: offer.expectedExecutionSeconds,
    }]);

    const fee = intent.sourceAmount * offer.feeBps / 10000;
    const afterFee = intent.sourceAmount - fee;
    const converted = afterFee * offer.rate;
    const incentive = converted * offer.incentiveBps / 10000;
    const netOutput = converted + incentive;
    routes.push({
      legs: [{
        providerId: provider.id, providerName: provider.name,
        sourceAsset: offer.sourceAsset, destinationAsset: offer.destinationAsset,
        sourceCountry: offer.sourceCountry, destinationCountry: offer.destinationCountry,
        feeBps: offer.feeBps, rate: offer.rate, channelType: offer.channelType,
        amount: intent.sourceAmount, role: "SOURCE",
        expectedExecutionSeconds: offer.expectedExecutionSeconds,
        offerCapacity: offer.availableCapacity,
        settlementAssetId: offer.settlementAssetId,
        providerRisk, settlementAssetRisk: saRiskInput,
      }],
      effectiveCost: fee, netOutput,
      expectedExecutionSeconds: offer.expectedExecutionSeconds,
      riskComposite: routeRisk.composite, tag: "DIRECT",
      explanation: `Direct via ${provider.name}`,
      settlementAssetIds: offer.settlementAssetId ? [offer.settlementAssetId] : [],
    });
  }

  // Multi-hop routes via ALL settlement assets (INCLUDING volatile tokens).
  // The risk ceiling determines eligibility — volatile tokens are NOT banned.
  for (const sa of assets.values()) {
    if (sa.status !== "ACTIVE") continue;
    const saRiskInput: SettlementAssetRiskInput = {
      assetType: sa.assetType, volatilityScore: sa.volatilityScore,
      liquidityScore: sa.liquidityScore, pegQuality: sa.pegQuality,
      status: sa.status, incentiveRate: sa.incentiveRate,
    };
    const saRisk = settlementAssetRisk(saRiskInput);
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
      const p1Risk: ProviderRiskInfo = {
        trustModel: p1.trustModel, providerType: p1.providerType,
        reputationScore: p1.reputationScore, status: p1.status,
      };
      if (providerCounterpartyRisk(p1Risk) > cpRiskCeiling) continue;

      for (const o2 of hop2Offers) {
        const p2 = providers.get(o2.providerId);
        if (!p2 || p2.status !== "ACTIVE") continue;
        const p2Risk: ProviderRiskInfo = {
          trustModel: p2.trustModel, providerType: p2.providerType,
          reputationScore: p2.reputationScore, status: p2.status,
        };
        if (providerCounterpartyRisk(p2Risk) > cpRiskCeiling) continue;

        const fee1 = intent.sourceAmount * o1.feeBps / 10000;
        const afterFee1 = intent.sourceAmount - fee1;
        const midAmount = afterFee1 * o1.rate;
        const fee2 = midAmount * o2.feeBps / 10000;
        const afterFee2 = midAmount - fee2;
        const finalAmount = afterFee2 * o2.rate;
        const incentive = finalAmount * (o1.incentiveBps + o2.incentiveBps) / 10000;
        const netOutput = finalAmount + incentive;
        const effectiveCost = fee1 + fee2;

        // Compute route risk using shared computeRouteRisk (5 dimensions).
        const routeRisk = computeRouteRisk([
          {
            provider: p1Risk, channelType: o1.channelType,
            offerCapacity: o1.availableCapacity, legAmount: intent.sourceAmount,
            settlementAsset: saRiskInput, expectedExecutionSeconds: o1.expectedExecutionSeconds,
          },
          {
            provider: p2Risk, channelType: o2.channelType,
            offerCapacity: o2.availableCapacity, legAmount: midAmount,
            settlementAsset: saRiskInput, expectedExecutionSeconds: o2.expectedExecutionSeconds,
          },
        ]);

        routes.push({
          legs: [
            {
              providerId: p1.id, providerName: p1.name,
              sourceAsset: o1.sourceAsset, destinationAsset: o1.destinationAsset,
              sourceCountry: o1.sourceCountry, destinationCountry: o1.destinationCountry,
              feeBps: o1.feeBps, rate: o1.rate, channelType: o1.channelType,
              amount: intent.sourceAmount, role: "SOURCE",
              expectedExecutionSeconds: o1.expectedExecutionSeconds,
              offerCapacity: o1.availableCapacity,
              settlementAssetId: o1.settlementAssetId,
              providerRisk: p1Risk, settlementAssetRisk: saRiskInput,
            },
            {
              providerId: p2.id, providerName: p2.name,
              sourceAsset: o2.sourceAsset, destinationAsset: o2.destinationAsset,
              sourceCountry: o2.sourceCountry, destinationCountry: o2.destinationCountry,
              feeBps: o2.feeBps, rate: o2.rate, channelType: o2.channelType,
              amount: midAmount, role: "DESTINATION",
              expectedExecutionSeconds: o2.expectedExecutionSeconds,
              offerCapacity: o2.availableCapacity,
              settlementAssetId: o2.settlementAssetId,
              providerRisk: p2Risk, settlementAssetRisk: saRiskInput,
            },
          ],
          effectiveCost, netOutput,
          expectedExecutionSeconds: Math.max(o1.expectedExecutionSeconds, o2.expectedExecutionSeconds),
          riskComposite: routeRisk.composite, tag: "MULTI_HOP",
          explanation: `Multi-hop via ${sa.symbol}: ${p1.name} → ${p2.name}`,
          settlementAssetIds: [sa.id],
        });
      }
    }
  }

  return routes;
}

// ---- Execute intent (tracks history for reputation, no += 0.001) -----------

function executeIntent(world: SimWorld, intent: SimIntent, route: SimCandidateRoute & { id: string }, rng: SeededRNG): void {
  const provider = world.providers.get(route.legs[0].providerId);
  if (!provider) { intent.status = "FAILED"; intent.failureReason = "provider not found"; return; }

  // Failure model based on provider reliability (shared counterparty risk).
  const cpRisk = providerCounterpartyRisk({
    trustModel: provider.trustModel, providerType: provider.providerType,
    reputationScore: provider.reputationScore, status: provider.status,
  });
  const failureRate = cpRisk * 0.1;
  if (rng.chance(failureRate)) {
    intent.status = "FAILED";
    intent.failureReason = "provider execution failure";
    provider.executionsFailed++;
    provider.totalPenalties += intent.sourceAmount * 0.001;

    // Record failed execution in history (for reputation recalculation).
    recordExecution(provider, intent, route, "FAILED", 0, world);
    return;
  }

  intent.status = "COMPLETED";
  intent.completedAtStep = world.step;
  intent.effectiveCost = route.effectiveCost;
  intent.netOutput = route.netOutput;
  intent.waitedSteps = world.step - intent.createdAtStep;
  intent.selectedRouteId = route.id;
  intent.routeTag = route.tag;

  const durationSec = route.expectedExecutionSeconds;

  // Update provider economics (aggregate totals).
  for (const leg of route.legs) {
    const p = world.providers.get(leg.providerId);
    if (!p) continue;
    const fee = leg.amount * leg.feeBps / 10000;
    p.totalVolume += leg.amount;
    p.totalEarnings += fee;
    p.executionsCompleted++;

    // Record completed execution in history (for reputation recalculation).
    // Only meaningful transactions (>= $50) affect reputation — the shared
    // calculateReputation function handles the threshold internally via
    // valueWeight, but we record all so the history is complete.
    recordExecution(p, intent, route, "COMPLETED", durationSec, world, leg);
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

function recordExecution(
  provider: SimProvider,
  intent: SimIntent,
  route: SimCandidateRoute & { id: string },
  outcome: "COMPLETED" | "FAILED" | "CANCELLED",
  durationSeconds: number,
  world: SimWorld,
  leg?: SimCandidateRoute["legs"][0],
): void {
  const legInfo = leg ?? route.legs[0];
  const corridorKey = `${provider.id}:${legInfo.sourceAsset}:${legInfo.destinationAsset}::`;
  const record: SimExecutionRecord = {
    providerId: provider.id,
    amount: legInfo.amount,
    outcome,
    durationSeconds,
    step: world.step,
    timeMs: world.timeMs,
    feeBps: legInfo.feeBps,
    corridorKey,
  };
  provider.executionHistory.push(record);
  // Cap history to prevent unbounded growth (keep last 500 records).
  if (provider.executionHistory.length > 500) {
    provider.executionHistory = provider.executionHistory.slice(-500);
  }
}

// ---- Provider offer updates (strategy-based pricing) ----------------------

function updateProviderOffers(world: SimWorld, rng: SeededRNG): void {
  for (const offer of world.offers.values()) {
    const provider = world.providers.get(offer.providerId);
    if (!provider || provider.status !== "ACTIVE" || !offer.active) continue;
    const utilization = offer.availableCapacity > 0 ? offer.reservedCapacity / offer.availableCapacity : 0;
    provider.utilization = utilization;

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

// ---- Provider entry/exit (using shared risk-adjusted return) --------------

function handleProviderEntryExit(world: SimWorld, rng: SeededRNG): void {
  // Entry.
  if (rng.chance(world.config.providerGrowthRate)) {
    generateNewProvider(world, rng, world.step);
  }

  const networkMedianFee = calculateNetworkMedianFee(world);
  const stepsPerYear = (365 * 24 * 3600 * 1000) / world.config.stepDurationMs;

  // Exit based on risk-adjusted return (shared calculateProviderEconomics).
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const steps = world.step - provider.entryStep;
    if (steps < 10) continue;

    const econ = computeProviderEconomicsForProvider(provider, world, stepsPerYear);

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

  // Recompute reputation + tier using shared calculateReputation from history.
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const steps = world.step - provider.entryStep;
    const ageDays = (steps * world.config.stepDurationMs) / DAY_MS;
    const repInput = buildReputationInput(provider, world, ageDays, networkMedianFee);
    const rep = calculateReputation(repInput);
    provider.reputationScore = rep.overall / 100;
    provider.tier = deriveTier(rep.overall, rep.sampleSize, ageDays, repInput.weightedSlashes);
  }
}

// ---- Provider economics helper (shared calculateProviderEconomics) --------

function computeProviderEconomicsForProvider(
  provider: SimProvider,
  world: SimWorld,
  stepsPerYear: number,
) {
  const input: ProviderEconomicsInput = {
    grossFees: provider.totalEarnings,
    incentives: provider.totalIncentives,
    rebates: 0,
    settlementCosts: provider.totalVolume * SETTLEMENT_COST_BPS / 10000,
    operatingCosts: provider.totalVolume * OPERATING_COST_BPS / 10000,
    capitalCostRate: CAPITAL_COST_RATE_ANNUAL,
    averageDeployedCapital: provider.usableCollateral,
    expectedLossRate: EXPECTED_LOSS_RATE,
    penalties: provider.totalPenalties,
    slashing: provider.totalSlashing,
    stepsPerYear,
  };
  return calculateProviderEconomics(input);
}

// ---- Campaign updates -----------------------------------------------------

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

// ---- Shocks ---------------------------------------------------------------

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

// ---- Metrics collection (uses shared detectEquilibrium) -------------------

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

  // Provider economics using shared calculateProviderEconomics.
  const stepsPerYear = (365 * 24 * 3600 * 1000) / world.config.stepDurationMs;
  const providerEcons = activeProviders.map(p => computeProviderEconomicsForProvider(p, world, stepsPerYear));
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

// ---- Reputation helpers (faithful recalculation from history) -------------
//
// These build a ReputationInput from the provider's execution history using
// the shared decayWeight + valueWeight functions (same as production's
// getProviderReputation), then call shared.calculateReputation.

function buildReputationMap(world: SimWorld): Map<string, number> {
  const map = new Map<string, number>();
  const networkMedianFee = calculateNetworkMedianFee(world);
  for (const p of world.providers.values()) {
    if (p.status !== "ACTIVE") continue;
    const ageDays = ((world.step - p.entryStep) * world.config.stepDurationMs) / DAY_MS;
    const repInput = buildReputationInput(p, world, ageDays, networkMedianFee);
    const rep = calculateReputation(repInput);
    map.set(p.id, rep.overall / 100);
  }
  return map;
}

function buildReputationInput(
  p: SimProvider,
  world: SimWorld,
  ageDays: number,
  networkMedianFee: number,
): ReputationInput {
  // Iterate execution history, applying recency + value weighting using the
  // shared decayWeight + valueWeight functions (same as production).
  let weightedCompleted = 0;
  let weightedFailed = 0;
  let weightedCancelled = 0;
  let weightedDurationSum = 0;
  let weightedDurationCount = 0;
  let meaningfulExecutions = 0;
  let totalFeeWeight = 0;
  let feeWeightCount = 0;

  for (const rec of p.executionHistory) {
    // Anti-gaming: skip sub-threshold transactions.
    if (rec.amount < MEANINGFUL_THRESHOLD) continue;

    meaningfulExecutions++;
    const ageMs = world.timeMs - rec.timeMs;
    const recency = decayWeight(ageMs);
    const vw = valueWeight(rec.amount);
    const weight = vw * recency;

    if (rec.outcome === "COMPLETED") {
      weightedCompleted += weight;
      weightedDurationSum += rec.durationSeconds * weight;
      weightedDurationCount += weight;
      totalFeeWeight += rec.feeBps * weight;
      feeWeightCount += weight;
    } else if (rec.outcome === "FAILED") {
      weightedFailed += weight;
    } else if (rec.outcome === "CANCELLED") {
      weightedCancelled += weight;
    }
  }

  const avgDuration = weightedDurationCount > 0 ? weightedDurationSum / weightedDurationCount : 0;
  const medianFeeBps = feeWeightCount > 0 ? totalFeeWeight / feeWeightCount : networkMedianFee;

  return {
    completed: 0, failed: 0, cancelled: 0, disputes: 0, slashes: 0,
    avgDurationSeconds: avgDuration,
    utilization: p.utilization,
    medianFeeBps,
    networkMedianFeeBps: networkMedianFee,
    ageDays,
    weightedCompleted,
    weightedFailed,
    weightedCancelled,
    weightedDisputes: 0,
    weightedSlashes: 0,
    meaningfulExecutions,
  };
}

function buildCorridorScoreMap(world: SimWorld): Map<string, number> {
  // Build corridor scores from execution history (completion rate + speed).
  const corridorStats = new Map<string, { completed: number; failed: number; totalDuration: number; count: number }>();
  for (const p of world.providers.values()) {
    for (const rec of p.executionHistory) {
      const cur = corridorStats.get(rec.corridorKey) ?? { completed: 0, failed: 0, totalDuration: 0, count: 0 };
      if (rec.outcome === "COMPLETED") {
        cur.completed++;
        cur.totalDuration += rec.durationSeconds;
      } else if (rec.outcome === "FAILED") {
        cur.failed++;
      }
      cur.count++;
      corridorStats.set(rec.corridorKey, cur);
    }
  }
  const map = new Map<string, number>();
  for (const [key, stats] of corridorStats) {
    const completionRate = stats.count > 0 ? stats.completed / stats.count : 0.5;
    const avgDuration = stats.completed > 0 ? stats.totalDuration / stats.completed : 300;
    const speedFactor = Math.max(0, 1 - avgDuration / 600);
    map.set(key, completionRate * 0.7 + speedFactor * 0.3);
  }
  return map;
}

function buildCommitmentReliabilityMap(_world: SimWorld): Map<string, number> {
  // Commitments are not simulated in the current simulator. Return empty map
  // (providers get no commitment boost — matching production when no
  // commitments exist).
  return new Map();
}

function calculateNetworkMedianFee(world: SimWorld): number {
  const fees = [...world.offers.values()].filter(o => o.active).map(o => o.feeBps).sort((a, b) => a - b);
  return fees.length > 0 ? fees[Math.floor(fees.length / 2)] : 20;
}

// ---- Main simulation runner ------------------------------------------------

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
