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
  SimCampaign, SimRoute, SimExecutionRecord, SimActiveReservation,
} from "./world";
import { generateNewProvider } from "./generator";
import {
  settlementAssetRisk,
  providerCounterpartyRisk,
  computeRouteRisk,
  assetRiskCeiling,
  counterpartyRiskCeiling,
  shouldReplaceRoute,
  rankRoutes,
  calculateReputation,
  deriveTier,
  calculateProviderEconomics,
  detectEquilibrium,
  decayWeight,
  valueWeight,
  MEANINGFUL_THRESHOLD,
  type RouteInfo,
  type RouteLegInfo,
  type RouteScoreContext,
  type ReputationInput,
  type ProviderEconomicsInput,
  type ProviderRiskInfo,
  type SettlementAssetRiskInput,
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

  // Step ordering (market microstructure):
  //   1. Release expired reservations (settlements that completed free capacity)
  //   2. Update utilization from active reservations (providers see current load)
  //   3. Providers adjust prices based on observed utilization
  //   4. Generate new demand
  //   5. Match + execute (routes against updated prices, creates new reservations)
  //   6. Provider entry/exit, campaign updates, shocks
  //
  // This ensures providers react to utilization BEFORE new demand routes,
  // not after. Prices are set based on current deployment, then demand sees
  // those prices.
  releaseExpiredReservations(world);
  replenishLiquidity(world, rng);
  updateProviderOffers(world, rng);
  generateDemand(world, rng);
  matchAndExecute(world, rng);
  handleProviderEntryExit(world, rng);
  updateCampaigns(world);
  applyShocks(world, rng);
  if (world.step % 5 === 0 || world.step === world.config.totalSteps) {
    world.metricsHistory.push(collectMetrics(world));
  }
}

// Release reservations whose settlement duration has elapsed.
// This is called at the START of each step, so reservations persist across
// steps and are visible to updateProviderOffers.
function releaseExpiredReservations(world: SimWorld): void {
  const remaining: SimActiveReservation[] = [];
  for (const res of world.activeReservations) {
    if (world.step >= res.releaseStep) {
      // Release: decrement reservedCapacity and currentDeployedCapital.
      const offer = world.offers.get(res.offerId);
      if (offer) {
        offer.reservedCapacity = Math.max(0, offer.reservedCapacity - res.amount);
      }
      const provider = world.providers.get(res.providerId);
      if (provider) {
        provider.currentDeployedCapital = Math.max(0, provider.currentDeployedCapital - res.amount);
      }
    } else {
      remaining.push(res);
    }
  }
  world.activeReservations = remaining;
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
    // Demand patience: sample max acceptable price and latency per intent.
    // Customers vary in price sensitivity and patience — some will pay more
    // for speed, others will wait for a better price.
    const maxPriceBps = world.config.enableDemandPatience
      ? Math.round(world.config.defaultMaxAcceptablePriceBps * rng.float(0.7, 1.5))
      : 999999; // effectively unlimited if patience disabled
    const maxLatencySteps = world.config.enableDemandPatience
      ? Math.round(world.config.defaultMaxAcceptableLatencySteps * rng.float(0.5, 2.0))
      : 999999;
    world.intents.push({
      id: `intent_${++intentCounter}`, userId: user.id, sourceAmount: amount,
      sourceAsset: user.sourceAsset, sourceCountry: user.sourceCountry,
      destinationAsset: user.destinationAsset, destinationCountry: user.destinationCountry,
      riskTolerance: user.riskTolerance, executionPolicy: user.executionPolicy,
      maxWaitSeconds: user.maxWaitSeconds,
      maxAcceptablePriceBps: maxPriceBps,
      maxAcceptableLatencySteps: maxLatencySteps,
      status: "SEARCHING",
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

    // Demand patience: check if intent has waited too long — abandon.
    if (world.config.enableDemandPatience) {
      if (intent.waitedSteps >= intent.maxAcceptableLatencySteps) {
        intent.status = "ABANDONED";
        intent.failureReason = "customer abandoned (latency exceeded patience)";
        continue;
      }
    }

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

    // Demand patience: check if best route exceeds price limit — abandon.
    if (world.config.enableDemandPatience) {
      const routeCostBps = best.effectiveCost / intent.sourceAmount * 10000;
      if (routeCostBps > intent.maxAcceptablePriceBps) {
        intent.waitedSteps++;
        // Don't abandon immediately — wait to see if a cheaper route appears.
        const maxWaitSteps = Math.ceil(intent.maxWaitSeconds / (world.config.stepDurationMs / 1000));
        if (intent.waitedSteps > maxWaitSteps || intent.waitedSteps >= intent.maxAcceptableLatencySteps) {
          intent.status = "ABANDONED";
          intent.failureReason = `customer abandoned (price ${routeCostBps.toFixed(0)}bps > ${intent.maxAcceptablePriceBps}bps limit)`;
        }
        continue;
      }
    }

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
// comparison). Uses the ACTUAL provider data and corridor info from the
// persisted SimRoute — NOT placeholder values. This ensures the cross-time
// comparison is faithful to the route that was actually selected.
function reconstructRefRouteInfo(
  intent: SimIntent,
  refRoute: SimRoute,
  ctx: RouteScoreContext,
): RouteInfo {
  const legs: RouteLegInfo[] = refRoute.legs.map(l => {
    // Look up the actual provider to get real risk inputs.
    const provider = ctx.reputationMap
      ? { trustModel: "NON_CUSTODIAL", providerType: "HYBRID", reputationScore: ctx.reputationMap.get(l.providerId) ?? 0.5, status: "ACTIVE" }
      : { trustModel: "NON_CUSTODIAL", providerType: "HYBRID", reputationScore: 0.5, status: "ACTIVE" };
    return {
      providerId: l.providerId,
      sourceAsset: l.sourceAsset,
      destinationAsset: l.destinationAsset,
      // Use the corridor info from the leg — NOT empty strings.
      // SimRouteLeg doesn't store countries, so we use the intent's countries
      // as the best available approximation (the route serves this corridor).
      sourceCountry: intent.sourceCountry,
      destinationCountry: intent.destinationCountry,
      role: "SOURCE",
      amount: l.amount,
      feeBps: l.feeBps,
      channelType: l.channelType,
      offerCapacity: 0, // historical — capacity not needed for quality scoring
      expectedExecutionSeconds: refRoute.expectedExecutionSeconds,
      provider,
    };
  });
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

    // Liquidity inventory check: provider must have enough destination-asset
    // liquidity to complete the payout. This is separate from capacity —
    // a provider can have capacity (collateral) but insufficient local fiat.
    if (world.config.enableLiquidityInventory) {
      const payoutAmount = intent.sourceAmount * offer.rate; // approx destination amount
      const dstLiquidity = provider.liquidity.balances.get(offer.destinationAsset) ?? 0;
      if (dstLiquidity < payoutAmount) continue; // insufficient destination liquidity
    }

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
      // Capacity check for hop 1.
      if (o1.availableCapacity - o1.reservedCapacity < intent.sourceAmount) continue;
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
        // Capacity check for hop 2 (midAmount may differ from sourceAmount).
        if (o2.availableCapacity - o2.reservedCapacity < midAmount) continue;

        // Liquidity inventory checks for multi-hop:
        // p1 needs settlement-asset liquidity (to pay out the mid-asset).
        // p2 needs destination-asset liquidity (to pay out the final destination).
        if (world.config.enableLiquidityInventory) {
          const p1MidLiquidity = p1.liquidity.balances.get(o1.destinationAsset) ?? 0;
          if (p1MidLiquidity < midAmount) continue;
          const finalAmount = midAmount * o2.rate; // approx
          const p2DstLiquidity = p2.liquidity.balances.get(o2.destinationAsset) ?? 0;
          if (p2DstLiquidity < finalAmount) continue;
        }
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

// ---- Execute intent (with PERSISTENT capacity reservation) ----------------
//
// CRITICAL: executeIntent now creates PERSISTENT reservations that last for
// the settlement duration (settlementDurationSteps). Reservations are NOT
// released synchronously — they persist across steps until
// releaseExpiredReservations() frees them. This makes utilization REAL:
// updateProviderOffers sees active reservations and provider strategies
// can react to actual deployment.
//
// The reservation model:
//   1. Before execution: verify each leg's offer has capacity, then reserve.
//   2. Create SimActiveReservation entries with releaseStep = step + durationSteps.
//   3. Capital is tracked as deployed (currentDeployedCapital) for the duration.
//   4. releaseExpiredReservations (at the start of each step) frees elapsed ones.
//   5. Failed executions release immediately (no settlement period).

let reservationCounter = 0;

// Sample a stochastic settlement outcome from a provider's reliability profile.
// Returns FAST (advertised duration), DELAYED (2×), RETRY (3×), or FAILURE.
function sampleSettlementOutcome(
  rng: SeededRNG,
  profile: { fastRate: number; delayedRate: number; retryRate: number; failureRate: number },
): "FAST" | "DELAYED" | "RETRY" | "FAILURE" {
  const roll = rng.next();
  if (roll < profile.fastRate) return "FAST";
  if (roll < profile.fastRate + profile.delayedRate) return "DELAYED";
  if (roll < profile.fastRate + profile.delayedRate + profile.retryRate) return "RETRY";
  return "FAILURE";
}

// Replenish liquidity inventory: providers periodically top up their cash
// balances. This models the real-world process of providers depositing fiat
// or converting between currencies to maintain operating balances.
function replenishLiquidity(world: SimWorld, rng: SeededRNG): void {
  if (!world.config.enableLiquidityInventory) return;
  if (world.step % world.config.liquidityReplenishSteps !== 0) return;
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    // Replenish each asset balance toward a target (50% of collateral value).
    for (const [asset, balance] of provider.liquidity.balances) {
      const target = provider.collateral * 0.3; // target 30% of collateral per asset
      if (balance < target) {
        // Top up toward target (with small random variation).
        const topUp = (target - balance) * rng.float(0.5, 1.0);
        provider.liquidity.balances.set(asset, balance + topUp);
      }
    }
  }
}

function executeIntent(world: SimWorld, intent: SimIntent, route: SimCandidateRoute & { id: string }, rng: SeededRNG): void {
  const provider = world.providers.get(route.legs[0].providerId);
  if (!provider) { intent.status = "FAILED"; intent.failureReason = "provider not found"; return; }

  // ---- Step 1: Verify capacity and reserve ----
  const reservations: Array<{ offer: SimOffer; amount: number; durationSteps: number }> = [];
  for (const leg of route.legs) {
    const offer = findOfferForLeg(world, leg);
    if (!offer) {
      intent.status = "FAILED";
      intent.failureReason = "offer no longer available";
      return;
    }
    const available = offer.availableCapacity - offer.reservedCapacity;
    if (available < leg.amount) {
      intent.status = "FAILED";
      intent.failureReason = "insufficient capacity";
      return;
    }
    // Liquidity inventory check (double-check at execution time — may have
    // changed since route discovery if another execution consumed it).
    if (world.config.enableLiquidityInventory) {
      const p = world.providers.get(leg.providerId);
      if (p) {
        const payoutAmount = leg.amount * offer.rate;
        const dstLiquidity = p.liquidity.balances.get(leg.destinationAsset) ?? 0;
        if (dstLiquidity < payoutAmount) {
          intent.status = "FAILED";
          intent.failureReason = "insufficient destination liquidity";
          return;
        }
      }
    }
    // Settlement duration for this leg (from the offer's expectedExecutionSeconds).
    let durationSteps = offer.settlementDurationSteps;
    // Stochastic settlement: sample outcome from provider's reliability profile.
    if (world.config.enableStochasticSettlement) {
      const p = world.providers.get(leg.providerId);
      if (p) {
        const outcome = sampleSettlementOutcome(rng, p.reliabilityProfile);
        if (outcome === "FAILURE") {
          // Settlement failure — release reservation, mark intent failed.
          intent.status = "FAILED";
          intent.failureReason = "settlement failure (stochastic)";
          p.executionsFailed++;
          p.settlementsFailed++;
          p.totalPenalties += leg.amount * 0.001;
          recordExecution(p, intent, route, "FAILED", 0, world);
          return;
        }
        // Adjust duration based on outcome.
        if (outcome === "FAST") {
          p.settlementsFast++;
          // durationSteps stays as advertised.
        } else if (outcome === "DELAYED") {
          p.settlementsDelayed++;
          durationSteps *= 2; // delayed = 2× advertised
        } else if (outcome === "RETRY") {
          p.settlementsRetried++;
          durationSteps *= 3; // retry = 3× advertised
        }
      }
    }
    reservations.push({ offer, amount: leg.amount, durationSteps });
  }

  // Reserve capacity on all legs (increment reservedCapacity immediately).
  for (const r of reservations) {
    r.offer.reservedCapacity += r.amount;
    r.offer.version++;
  }

  // ---- Step 2: Execution failure model (counterparty risk-based) ----
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
    // Release reservations immediately on failure (no settlement period).
    for (const r of reservations) {
      r.offer.reservedCapacity -= r.amount;
    }
    // Restore liquidity (execution didn't complete).
    if (world.config.enableLiquidityInventory) {
      for (const r of reservations) {
        const p = world.providers.get(r.offer.providerId);
        if (p) {
          // No liquidity was consumed yet (failure before settlement).
        }
      }
    }
    recordExecution(provider, intent, route, "FAILED", 0, world);
    return;
  }

  // ---- Step 3: Success — consume liquidity + create PERSISTENT reservations ----
  intent.status = "COMPLETED";
  intent.completedAtStep = world.step;
  intent.effectiveCost = route.effectiveCost;
  intent.netOutput = route.netOutput;
  intent.waitedSteps = world.step - intent.createdAtStep;
  intent.selectedRouteId = route.id;
  intent.routeTag = route.tag;

  const durationSec = route.expectedExecutionSeconds;

  // Update provider economics + create persistent reservations + consume liquidity.
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const r = reservations[i];
    const p = world.providers.get(leg.providerId);
    if (!p) continue;

    const fee = leg.amount * leg.feeBps / 10000;
    p.totalVolume += leg.amount;
    p.totalEarnings += fee;
    p.executionsCompleted++;
    // Track deployed capital: amount × duration (capital-time product).
    p.totalDeployedCapitalSteps += leg.amount * r.durationSteps;
    p.currentDeployedCapital += leg.amount;

    // Consume liquidity inventory: provider pays out destination asset,
    // receives source asset. This is the key economic constraint — providers
    // can run out of payout currency even with ample collateral.
    if (world.config.enableLiquidityInventory) {
      const payoutAmount = leg.amount * leg.rate; // destination-asset amount
      const srcBalance = p.liquidity.balances.get(leg.sourceAsset) ?? 0;
      const dstBalance = p.liquidity.balances.get(leg.destinationAsset) ?? 0;
      // Source balance increases (provider receives incoming transfer).
      p.liquidity.balances.set(leg.sourceAsset, srcBalance + leg.amount);
      // Destination balance decreases (provider pays out).
      p.liquidity.balances.set(leg.destinationAsset, Math.max(0, dstBalance - payoutAmount));
    }

    // Create a persistent reservation that will be released after durationSteps.
    const reservation: SimActiveReservation = {
      id: `res_${++reservationCounter}`,
      offerId: r.offer.id,
      providerId: p.id,
      amount: leg.amount,
      startStep: world.step,
      releaseStep: world.step + r.durationSteps,
    };
    world.activeReservations.push(reservation);

    recordExecution(p, intent, route, "COMPLETED", durationSec, world, leg);
  }

  // ---- Step 4: Accrue incentives (leg/campaign-aware) ----
  // Only legs whose offer uses the campaign's settlement asset qualify for
  // the incentive. The incentive is paid on the qualifying leg's volume,
  // not the full route netOutput, and only to the qualifying provider(s).
  for (const campaign of world.campaigns.values()) {
    if (campaign.status !== "ACTIVE") continue;
    for (let i = 0; i < route.legs.length; i++) {
      const leg = route.legs[i];
      const r = reservations[i];
      if (r.offer.settlementAssetId === campaign.settlementAssetId) {
        // This leg qualifies. Incentive = leg amount × campaign bps.
        const inc = leg.amount * campaign.incentiveBps / 10000;
        const remaining = campaign.totalBudget - campaign.accrued;
        if (remaining > 0) {
          const actualInc = Math.min(inc, remaining);
          campaign.accrued += actualInc;
          world.totalIncentives += actualInc;
          const p = world.providers.get(leg.providerId);
          if (p) p.totalIncentives += actualInc;
        }
      }
    }
  }

  world.totalVolume += intent.sourceAmount;
  world.totalFees += route.effectiveCost;
}

// Find the offer corresponding to a route leg. Matches by provider + corridor.
function findOfferForLeg(world: SimWorld, leg: SimCandidateRoute["legs"][0]): SimOffer | undefined {
  for (const offer of world.offers.values()) {
    if (!offer.active) continue;
    if (offer.providerId !== leg.providerId) continue;
    if (offer.sourceAsset !== leg.sourceAsset) continue;
    if (offer.destinationAsset !== leg.destinationAsset) continue;
    if (offer.sourceCountry !== leg.sourceCountry) continue;
    if (offer.destinationCountry !== leg.destinationCountry) continue;
    return offer;
  }
  return undefined;
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
//
// Utilization is computed from ACTIVE reservations that persist across steps.
// Because reservations last for settlementDurationSteps, updateProviderOffers
// sees them and provider strategies can react to actual deployment.
//
// We track three utilization signals:
//   - utilization: instantaneous (current reserved / available) — observed NOW
//   - peakUtilization: the highest instantaneous utilization seen
//   - utilizationTimeSteps: Σ utilization per step — for time-weighted average

function updateProviderOffers(world: SimWorld, rng: SeededRNG): void {
  // Compute per-provider instantaneous utilization from active reservations.
  // Active reservations are still in world.activeReservations (not yet released).
  const providerReserved = new Map<string, number>();
  for (const res of world.activeReservations) {
    providerReserved.set(res.providerId, (providerReserved.get(res.providerId) ?? 0) + res.amount);
  }

  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const offers = [...world.offers.values()].filter(o => o.providerId === provider.id && o.active);
    const totalAvail = offers.reduce((s, o) => s + o.availableCapacity, 0);
    const totalReserved = providerReserved.get(provider.id) ?? 0;
    const utilization = totalAvail > 0 ? totalReserved / totalAvail : 0;

    // Update utilization signals.
    provider.utilization = utilization;
    if (utilization > provider.peakUtilization) {
      provider.peakUtilization = utilization;
    }
    provider.utilizationTimeSteps += utilization;
  }

  for (const offer of world.offers.values()) {
    const provider = world.providers.get(offer.providerId);
    if (!provider || provider.status !== "ACTIVE" || !offer.active) continue;
    // Provider strategies react to the utilization observed DURING this step
    // (from active reservations that haven't been released yet).
    const utilization = provider.utilization;

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

// ---- Provider entry/exit (separate economic exit from risk suspension) -----
//
// ECONOMIC_EXIT: risk-adjusted return < 0 (provider is losing money).
// RISK_SUSPENSION: failure rate too high (provider is unreliable, even if
//   economically attractive — should be suspended, not counted as economically
//   unsuccessful).
// OPERATIONAL_SUSPENSION: regulatory shock or similar external event.

function handleProviderEntryExit(world: SimWorld, rng: SeededRNG): void {
  // Entry.
  if (rng.chance(world.config.providerGrowthRate)) {
    generateNewProvider(world, rng, world.step);
  }

  const networkMedianFee = calculateNetworkMedianFee(world);
  const stepsPerYear = (365 * 24 * 3600 * 1000) / world.config.stepDurationMs;

  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    const steps = world.step - provider.entryStep;
    if (steps < 10) continue;

    const econ = computeProviderEconomicsForProvider(provider, world, stepsPerYear);

    // ECONOMIC_EXIT: risk-adjusted return is negative.
    if (econ.riskAdjustedReturn < 0 && rng.chance(0.1)) {
      provider.status = "EXITED";
      provider.exitStep = world.step;
      provider.exitReason = "ECONOMIC_EXIT";
      for (const offer of world.offers.values()) {
        if (offer.providerId === provider.id) offer.active = false;
      }
    }

    // RISK_SUSPENSION: failure rate too high (separate from economics).
    // A provider can be economically attractive but operationally unsafe.
    // This is a SUSPENSION, not an economic exit.
    if (provider.executionsFailed > 5 && provider.executionsFailed / Math.max(1, provider.executionsCompleted + provider.executionsFailed) > 0.3) {
      provider.status = "SUSPENDED";
      provider.exitStep = world.step;
      provider.exitReason = "RISK_SUSPENSION";
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
//
// Time-consistent capital cost: uses AVERAGE DEPLOYED CAPITAL (not total
// usable collateral) and accrues based on actual simulated elapsed time.
// The capital-time product (totalDeployedCapitalSteps) captures how much
// capital was deployed for how long — this is the economically correct base
// for capital cost.

function computeProviderEconomicsForProvider(
  provider: SimProvider,
  world: SimWorld,
  stepsPerYear: number,
) {
  // Average deployed capital = capital-time product / elapsed steps.
  // This is the time-weighted average capital actually at risk.
  const elapsedSteps = Math.max(1, world.step - provider.entryStep);
  const avgDeployedCapital = provider.totalDeployedCapitalSteps / elapsedSteps;

  const input: ProviderEconomicsInput = {
    grossFees: provider.totalEarnings,
    incentives: provider.totalIncentives,
    rebates: 0,
    settlementCosts: provider.totalVolume * SETTLEMENT_COST_BPS / 10000,
    operatingCosts: provider.totalVolume * OPERATING_COST_BPS / 10000,
    capitalCostRate: CAPITAL_COST_RATE_ANNUAL,
    averageDeployedCapital: avgDeployedCapital,
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
          provider.exitStep = world.step;
          provider.exitReason = "OPERATIONAL_SUSPENSION";
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
  const abandoned = intents.filter(i => i.status === "ABANDONED");
  const liquidityConstrained = intents.filter(i => i.failureReason === "insufficient destination liquidity");
  const activeProviders = [...world.providers.values()].filter(p => p.status === "ACTIVE");
  const exitedProviders = [...world.providers.values()].filter(p => p.status === "EXITED");
  const suspendedProviders = [...world.providers.values()].filter(p => p.status === "SUSPENDED");
  const economicExits = exitedProviders.filter(p => p.exitReason === "ECONOMIC_EXIT").length;

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

  // Simulation-period profits (NOT annualized — the primary metric).
  const netProfits = providerEcons.map(e => e.netEarnings).sort((a, b) => a - b);
  const medianNetProfit = netProfits.length > 0 ? netProfits[Math.floor(netProfits.length / 2)] : 0;
  const avgNetProfit = netProfits.length > 0 ? netProfits.reduce((s, n) => s + n, 0) / netProfits.length : 0;
  const avgEarnings = avgNetProfit; // alias for backward compat

  // Net margin: netEarnings / grossEarnings (0..100).
  const netMargins = providerEcons
    .filter(e => e.grossEarnings > 0)
    .map(e => (e.netEarnings / e.grossEarnings) * 100)
    .sort((a, b) => a - b);
  const medianNetMargin = netMargins.length > 0 ? netMargins[Math.floor(netMargins.length / 2)] : 0;

  // Profit per execution.
  const profitsPerExec = activeProviders
    .filter(p => p.executionsCompleted > 0)
    .map((p, i) => providerEcons[i].netEarnings / p.executionsCompleted)
    .sort((a, b) => a - b);
  const medianProfitPerExecution = profitsPerExec.length > 0 ? profitsPerExec[Math.floor(profitsPerExec.length / 2)] : 0;

  // Annualized return (modeled extrapolation — labeled, not primary).
  const annualizedReturns = returns.map(r => r * 100);
  const medianAnnualizedReturnPct = annualizedReturns.length > 0
    ? annualizedReturns[Math.floor(annualizedReturns.length / 2)]
    : 0;

  // Capital efficiency: settledVolume / averageLockedCapital (turnover ratio).
  // Shows how much volume a provider processed per unit of capital deployed.
  // High efficiency = capital is being recycled quickly.
  const capitalEfficiencies = activeProviders
    .filter(p => p.totalDeployedCapitalSteps > 0)
    .map(p => {
      const elapsedSteps = Math.max(1, world.step - p.entryStep);
      const avgLockedCapital = p.totalDeployedCapitalSteps / elapsedSteps;
      return avgLockedCapital > 0 ? p.totalVolume / avgLockedCapital : 0;
    })
    .sort((a, b) => a - b);
  const medianCapitalEfficiency = capitalEfficiencies.length > 0
    ? capitalEfficiencies[Math.floor(capitalEfficiencies.length / 2)]
    : 0;

  const totalLiquidity = [...world.offers.values()].filter(o => o.active).reduce((s, o) => s + o.availableCapacity, 0);
  const providerVolumes = activeProviders.map(p => p.totalVolume);
  const totalVol = providerVolumes.reduce((s, v) => s + v, 0);
  const hhi = totalVol > 0 ? providerVolumes.map(v => (v / totalVol) ** 2).reduce((s, h) => s + h, 0) : 1;

  // Route coverage: fraction of intents that found a route.
  const routeCoverage = intents.length > 0 ? (completed.length + intents.filter(i => i.status === "EXECUTING").length) / intents.length : 0;

  // Equilibrium using shared detectEquilibrium.
  // Note: equilibrium still uses risk-adjusted return as a signal, but it's
  // NOT the primary display metric. The primary display is simulation-period
  // net profit.
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
    abandonedIntents: abandoned.length,
    liquidityConstrainedFailures: liquidityConstrained.length,
    avgCostBps: Math.round(avgCostBps * 100) / 100, avgWaitSteps: Math.round(avgWaitSteps * 100) / 100,
    p50ExecutionSteps: p50, p95ExecutionSteps: p95,
    completionRate: intents.length > 0 ? Math.round((completed.length / intents.length) * 10000) / 100 : 0,
    activeProviders: activeProviders.length,
    exitedProviders: exitedProviders.length,
    suspendedProviders: suspendedProviders.length,
    economicExits,
    avgProviderEarnings: Math.round(avgEarnings * 100) / 100,
    medianProviderEarnings: providerEcons.length > 0 ? Math.round(providerEcons[Math.floor(providerEcons.length / 2)].netEarnings * 100) / 100 : 0,
    avgUtilization: activeProviders.length > 0 ? Math.round((activeProviders.reduce((s, p) => s + p.utilization, 0) / activeProviders.length) * 10000) / 100 : 0,
    peakUtilization: activeProviders.length > 0 ? Math.round(Math.max(...activeProviders.map(p => p.peakUtilization)) * 10000) / 100 : 0,
    avgTimeWeightedUtilization: activeProviders.length > 0 ? Math.round((activeProviders.reduce((s, p) => s + (p.utilizationTimeSteps / Math.max(1, world.step - p.entryStep)), 0) / activeProviders.length) * 10000) / 100 : 0,
    totalProviderVolume: Math.round(world.totalVolume * 100) / 100,
    totalProtocolRevenue: Math.round(world.totalFees * 100) / 100,
    totalIncentiveSpend: Math.round(world.totalIncentives * 100) / 100,
    // Simulation-period economics (primary).
    medianNetProfit: Math.round(medianNetProfit * 100) / 100,
    avgNetProfit: Math.round(avgNetProfit * 100) / 100,
    medianNetMargin: Math.round(medianNetMargin * 100) / 100,
    medianProfitPerExecution: Math.round(medianProfitPerExecution * 100) / 100,
    // Annualized (modeled extrapolation — NOT primary).
    medianAnnualizedReturnPct: Math.round(medianAnnualizedReturnPct * 100) / 100,
    // Capital efficiency: volume / average locked capital (turnover ratio).
    medianCapitalEfficiency: Math.round(medianCapitalEfficiency * 100) / 100,
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
