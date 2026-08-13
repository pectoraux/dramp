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
  SimInFlightExecution, SimInFlightLeg, SimSettlementTransfer,
  toUsdValue,
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
  //   2. Process in-flight executions (complete settlements whose time is up)
  //   3. Replenish liquidity from treasury (conservation: treasury → operating)
  //   4. Update utilization from active reservations (providers see current load)
  //   5. Providers adjust prices based on observed utilization
  //   6. Generate new demand
  //   7. Match + execute (routes against updated prices, creates new reservations)
  //   8. Provider entry/exit, campaign updates, shocks
  releaseExpiredReservations(world);
  processInFlightExecutions(world, rng);
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

// Process in-flight executions: settle legs whose completionStep has arrived.
// Legs settle ASYNCHRONOUSLY in dependency order (leg N+1 starts only after
// leg N settles). This models the real multi-hop settlement chain.
//
// Conservation: for multi-hop routes, the intermediate settlement asset is
// transferred from the upstream provider (debit) to the downstream provider
// (credit). Debit == credit — no assets created or destroyed.
function processInFlightExecutions(world: SimWorld, rng: SeededRNG): void {
  const remaining: SimInFlightExecution[] = [];
  for (const exec of world.inFlightExecutions) {
    // Process legs in dependency order.
    let allSettled = true;
    let anyFailed = false;
    for (let i = 0; i < exec.legs.length; i++) {
      const leg = exec.legs[i];
      if (leg.status === "SETTLED") continue;
      if (leg.status === "FAILED") { anyFailed = true; break; }
      // This leg is PENDING or EXECUTING.
      if (leg.status === "PENDING") {
        // Check if upstream leg has settled (dependency chain).
        if (i > 0 && exec.legs[i - 1].status !== "SETTLED") {
          allSettled = false;
          break; // can't start this leg yet
        }
        // Start this leg: sample stochastic settlement outcome, set to EXECUTING.
        let durationSteps = leg.durationSteps;
        if (world.config.enableStochasticSettlement) {
          const p = world.providers.get(leg.providerId);
          if (p) {
            const outcome = sampleSettlementOutcome(rng, p.reliabilityProfile);
            if (outcome === "FAILURE") {
              // Settlement failure — mark leg failed, cancel execution.
              leg.status = "FAILED";
              leg.settlementOutcome = "FAILURE";
              p.executionsFailed++;
              p.settlementsFailed++;
              p.totalPenalties += leg.amount * 0.001;
              anyFailed = true;
              break;
            }
            leg.settlementOutcome = outcome;
            if (outcome === "DELAYED") durationSteps = leg.durationSteps * 2;
            else if (outcome === "RETRY") durationSteps = leg.durationSteps * 3;
          }
        }
        leg.durationSteps = durationSteps; // update with stochastic duration
        leg.status = "EXECUTING";
        leg.startStep = world.step;
        leg.completionStep = world.step + durationSteps;
        // Reserve capacity for this leg.
        const offer = world.offers.get(leg.offerId);
        if (offer) {
          offer.reservedCapacity += leg.reservation.amount;
          offer.version++;
        }
        const p = world.providers.get(leg.providerId);
        if (p) {
          p.currentDeployedCapital += leg.reservation.amount;
          p.totalDeployedCapitalSteps += leg.reservation.amount * durationSteps;
        }
        allSettled = false;
        break; // only one leg starts per step (dependency chain)
      }
      // leg.status === "EXECUTING" — check if it's time to settle.
      if (world.step >= leg.completionStep) {
        // Settle this leg (may transition to SETTLED or FAILED).
        settleLeg(world, exec, i);
        if ((leg.status as string) === "FAILED") {
          anyFailed = true;
          break;
        }
        // If this isn't the last leg, create a conserved transfer to the next leg.
        if (i < exec.legs.length - 1) {
          createSettlementTransfer(world, exec, i);
        }
      } else {
        allSettled = false;
        break; // still executing
      }
    }

    if (anyFailed) {
      failExecution(world, exec);
    } else if (allSettled) {
      completeExecution(world, exec);
    } else {
      remaining.push(exec);
    }
  }
  world.inFlightExecutions = remaining;
}

// Settle a single leg: consume liquidity, credit provider, release reservation.
// For the FIRST leg (external input): source balance increases (user pays in).
// For the LAST leg (external output): destination balance decreases (payout).
// For intermediate legs: the settlement asset is debited from this provider
// and credited to the next provider via createSettlementTransfer.
function settleLeg(world: SimWorld, exec: SimInFlightExecution, legIndex: number): void {
  const leg = exec.legs[legIndex];
  const p = world.providers.get(leg.providerId);
  if (!p) {
    leg.status = "FAILED";
    leg.settlementOutcome = "FAILURE";
    return;
  }

  const durationSec = (world.step - leg.startStep) * (world.config.stepDurationMs / 1000);

  // Credit provider economics.
  const fee = leg.amount * leg.feeBps / 10000;
  p.totalVolume += leg.amount;
  p.totalEarnings += fee;
  p.executionsCompleted++;

  // Track settlement outcome.
  if (leg.settlementOutcome === "FAST") p.settlementsFast++;
  else if (leg.settlementOutcome === "DELAYED") p.settlementsDelayed++;
  else if (leg.settlementOutcome === "RETRY") p.settlementsRetried++;

  // Consume liquidity CONSERVINGLY:
  if (world.config.enableLiquidityInventory) {
    // Source balance increases (provider receives the source asset).
    // For the first leg, this is external user input (boundary flow).
    // For intermediate legs, this is the settlement asset received from the
    // upstream provider via the transfer (credited in createSettlementTransfer).
    // For the last leg, the source asset IS the settlement asset from upstream.
    const srcBalance = p.liquidity.balances.get(leg.sourceAsset) ?? 0;
    p.liquidity.balances.set(leg.sourceAsset, srcBalance + leg.amount);

    // Destination balance decreases (provider pays out the destination asset).
    // For the last leg, this is the external payout (boundary flow).
    // For intermediate legs, this is the settlement asset paid to the next
    // provider — debited here, credited to the next provider in createSettlementTransfer.
    const dstBalance = p.liquidity.balances.get(leg.destinationAsset) ?? 0;
    p.liquidity.balances.set(leg.destinationAsset, Math.max(0, dstBalance - leg.payoutAmount));
  }

  // Release the reservation for this leg.
  const offer = world.offers.get(leg.offerId);
  if (offer) {
    offer.reservedCapacity = Math.max(0, offer.reservedCapacity - leg.reservation.amount);
  }
  p.currentDeployedCapital = Math.max(0, p.currentDeployedCapital - leg.reservation.amount);

  // Record execution in history (for reputation recalculation).
  const corridorKey = `${p.id}:${leg.sourceAsset}:${leg.destinationAsset}::`;
  const record: SimExecutionRecord = {
    providerId: p.id,
    amount: leg.amount,
    outcome: "COMPLETED",
    durationSeconds: durationSec,
    step: world.step,
    timeMs: world.timeMs,
    feeBps: leg.feeBps,
    corridorKey,
  };
  p.executionHistory.push(record);
  if (p.executionHistory.length > 500) {
    p.executionHistory = p.executionHistory.slice(-500);
  }

  // Accrue incentives for this leg (leg/campaign-aware).
  for (const campaign of world.campaigns.values()) {
    if (campaign.status !== "ACTIVE") continue;
    const offerForLeg = world.offers.get(leg.offerId);
    if (offerForLeg && offerForLeg.settlementAssetId === campaign.settlementAssetId) {
      const inc = leg.amount * campaign.incentiveBps / 10000;
      const remainingBudget = campaign.totalBudget - campaign.accrued;
      if (remainingBudget > 0) {
        const actualInc = Math.min(inc, remainingBudget);
        campaign.accrued += actualInc;
        world.totalIncentives += actualInc;
        p.totalIncentives += actualInc;
      }
    }
  }

  leg.status = "SETTLED";
}

// Create a conserved settlement transfer: the intermediate settlement asset
// moves from the upstream provider (who paid it out) to the downstream provider
// (who will receive it as source asset). Debit == credit.
// The upstream provider's destination-asset debit was already done in settleLeg.
// Here we credit the downstream provider's source-asset balance so that when
// their leg settles, the source balance increase matches the transfer.
function createSettlementTransfer(world: SimWorld, exec: SimInFlightExecution, fromLegIndex: number): void {
  const fromLeg = exec.legs[fromLegIndex];
  const toLeg = exec.legs[fromLegIndex + 1];
  // The settlement asset is the destination of the from-leg = source of the to-leg.
  const asset = fromLeg.destinationAsset;
  const amount = fromLeg.payoutAmount; // the amount paid out by from-leg

  // Credit the downstream provider's source-asset balance NOW (so it's available
  // when their leg starts executing). This is the conserved transfer:
  // from-leg debited the asset, to-leg credits it.
  if (world.config.enableLiquidityInventory) {
    const toProvider = world.providers.get(toLeg.providerId);
    if (toProvider) {
      const balance = toProvider.liquidity.balances.get(asset) ?? 0;
      toProvider.liquidity.balances.set(asset, balance + amount);
    }
  }

  // Record the transfer for auditing/metrics.
  const transfer: SimSettlementTransfer = {
    id: `transfer_${++reservationCounter}`,
    executionId: exec.id,
    fromProviderId: fromLeg.providerId,
    toProviderId: toLeg.providerId,
    asset,
    amount,
    fromLegIndex,
    toLegIndex: fromLegIndex + 1,
    settlementStep: world.step,
    status: "COMPLETED",
  };
  world.settlementTransfers.push(transfer);
}

// Fail an execution: an upstream leg failed, so downstream legs can't settle.
// Release all remaining reservations and mark intent FAILED.
function failExecution(world: SimWorld, exec: SimInFlightExecution): void {
  const intent = world.intents.find(i => i.id === exec.intentId);
  if (!intent) return;
  intent.status = "FAILED";
  intent.failureReason = "upstream settlement failure (dependency chain)";
  // Release all reservations for legs that were EXECUTING or PENDING.
  for (const leg of exec.legs) {
    if (leg.status === "EXECUTING" || leg.status === "PENDING") {
      const offer = world.offers.get(leg.offerId);
      if (offer) {
        offer.reservedCapacity = Math.max(0, offer.reservedCapacity - leg.reservation.amount);
      }
      const p = world.providers.get(leg.providerId);
      if (p) {
        p.currentDeployedCapital = Math.max(0, p.currentDeployedCapital - leg.reservation.amount);
        p.executionsFailed++;
      }
      leg.status = "FAILED";
    }
  }
}

// Complete an execution: all legs have settled. Mark intent COMPLETED.
function completeExecution(world: SimWorld, exec: SimInFlightExecution): void {
  const intent = world.intents.find(i => i.id === exec.intentId);
  if (!intent) return;
  intent.status = "COMPLETED";
  intent.completedAtStep = world.step;
  intent.effectiveCost = exec.effectiveCost;
  intent.netOutput = exec.netOutput;
  intent.waitedSteps = world.step - intent.createdAtStep;
  world.totalVolume += intent.sourceAmount;
  world.totalFees += exec.effectiveCost;
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

// Replenish liquidity inventory from treasury: transfers from treasury →
// operating balance. This CONSERVES money — no balances are created from nowhere.
// The treasury is a finite source; when it's depleted, the provider can't
// replenish and must wait for settlement receipts to restore operating liquidity.
function replenishLiquidity(world: SimWorld, rng: SeededRNG): void {
  if (!world.config.enableLiquidityInventory) return;
  if (world.step % world.config.liquidityReplenishSteps !== 0) return;
  for (const provider of world.providers.values()) {
    if (provider.status !== "ACTIVE") continue;
    // For each asset, if operating balance is below target, transfer from treasury.
    for (const [asset, operatingBalance] of provider.liquidity.balances) {
      const target = provider.collateral * 0.3; // target 30% of collateral per asset
      if (operatingBalance < target) {
        const needed = target - operatingBalance;
        const treasuryBalance = provider.treasury.balances.get(asset) ?? 0;
        if (treasuryBalance <= 0) continue; // treasury depleted — can't replenish
        // Transfer min(needed, treasuryBalance) from treasury → operating.
        const transfer = Math.min(needed * rng.float(0.5, 1.0), treasuryBalance);
        provider.liquidity.balances.set(asset, operatingBalance + transfer);
        provider.treasury.balances.set(asset, treasuryBalance - transfer);
        provider.totalReplenished += transfer;
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
    // Settlement duration for this leg (base — stochastic outcome sampled
    // when the leg STARTS executing in processInFlightExecutions).
    const durationSteps = offer.settlementDurationSteps;
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
    // NO liquidity was consumed (failure before settlement) — nothing to restore.
    recordExecution(provider, intent, route, "FAILED", 0, world);
    return;
  }

  // ---- Step 3: Success — create IN-FLIGHT execution with per-leg async state ----
  //
  // Legs settle ASYNCHRONOUSLY in dependency order:
  //   leg 0 starts EXECUTING now → settles → transfers asset to leg 1 →
  //   leg 1 starts EXECUTING → settles → ... → last leg settles → COMPLETED
  //
  // Only the FIRST leg starts executing now. Subsequent legs are PENDING until
  // their upstream leg settles and the intermediate settlement asset is transferred.
  // This models the real multi-hop dependency chain and conserves intermediate assets.
  intent.status = "EXECUTING";
  intent.selectedRouteId = route.id;
  intent.routeTag = route.tag;
  intent.effectiveCost = route.effectiveCost;
  intent.netOutput = route.netOutput;

  // Build per-leg in-flight state.
  const inFlightLegs: SimInFlightLeg[] = route.legs.map((leg, i) => {
    const r = reservations[i];
    const p = world.providers.get(leg.providerId);
    return {
      providerId: leg.providerId,
      offerId: r.offer.id,
      sourceAsset: leg.sourceAsset,
      destinationAsset: leg.destinationAsset,
      amount: leg.amount,
      rate: leg.rate,
      feeBps: leg.feeBps,
      payoutAmount: leg.amount * leg.rate,
      providerName: p?.name ?? "Unknown",
      // Per-leg async state.
      status: i === 0 ? "EXECUTING" : "PENDING",  // only first leg starts now
      startStep: i === 0 ? world.step : 0,
      completionStep: i === 0 ? world.step + r.durationSteps : 0,
      durationSteps: r.durationSteps,
      settlementOutcome: "FAST",  // will be set when leg settles
      reservation: { offerId: r.offer.id, providerId: leg.providerId, amount: leg.amount },
    };
  });

  // Reserve capacity ONLY for the first leg (subsequent legs reserve when they start).
  if (inFlightLegs.length > 0) {
    const firstLeg = inFlightLegs[0];
    const firstOffer = world.offers.get(firstLeg.offerId);
    if (firstOffer) {
      firstOffer.reservedCapacity += firstLeg.reservation.amount;
      firstOffer.version++;
    }
    const firstProvider = world.providers.get(firstLeg.providerId);
    if (firstProvider) {
      firstProvider.currentDeployedCapital += firstLeg.reservation.amount;
      firstProvider.totalDeployedCapitalSteps += firstLeg.reservation.amount * firstLeg.durationSteps;
    }
  }

  const inFlight: SimInFlightExecution = {
    id: `exec_${++reservationCounter}`,
    intentId: intent.id,
    routeId: route.id,
    legs: inFlightLegs,
    effectiveCost: route.effectiveCost,
    netOutput: route.netOutput,
    startStep: world.step,
    settlementOutcome: "FAST",
    currentLegIndex: 0,
  };
  world.inFlightExecutions.push(inFlight);

  // Note: liquidity is NOT consumed here. It will be consumed at each leg's
  // settlement in settleLeg(). Intermediate assets are conserved via
  // createSettlementTransfer(). Incentives are accrued per-leg at settlement.
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
  // Compute per-provider instantaneous utilization from:
  //   1. activeReservations (legacy, for backward compat)
  //   2. inFlightExecutions (P4.6 — reservations held during settlement)
  // Both persist across steps, so updateProviderOffers sees actual deployment.
  const providerReserved = new Map<string, number>();
  for (const res of world.activeReservations) {
    providerReserved.set(res.providerId, (providerReserved.get(res.providerId) ?? 0) + res.amount);
  }
  for (const exec of world.inFlightExecutions) {
    for (const leg of exec.legs) {
      providerReserved.set(leg.providerId, (providerReserved.get(leg.providerId) ?? 0) + leg.amount);
    }
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
    // Settlement lifecycle metrics (P4.6).
    inFlightExecutions: world.inFlightExecutions.length,
    avgSettlementLatencySteps: (() => {
      const latencies = completed.map(i => i.completedAtStep! - i.createdAtStep);
      return latencies.length > 0 ? Math.round(latencies.reduce((s, l) => s + l, 0) / latencies.length * 100) / 100 : 0;
    })(),
    p50SettlementLatencySteps: p50,
    p95SettlementLatencySteps: p95,
    totalLiquidityReplenished: Math.round(activeProviders.reduce((s, p) => s + p.totalReplenished, 0) * 100) / 100,
    totalExternalLiquidityInjected: 0,
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
    // Multi-hop conservation metrics (P4.7).
    internalSettlementVolume: Math.round(
      world.settlementTransfers.reduce((s, t) => s + toUsdValue(t.asset, t.amount), 0) * 100
    ) / 100,
    inFlightValueUsd: Math.round(
      world.inFlightExecutions.reduce((s, exec) =>
        s + exec.legs.reduce((ls, l) => ls + toUsdValue(l.sourceAsset, l.amount), 0), 0
      ) * 100
    ) / 100,
    settlementTransferCount: world.settlementTransfers.length,
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
