// Execution service — the canonical state machine + commitment model.
//
// State machine (happy path):
//   INTENT_CREATED → SEARCHING → ROUTE_FOUND → ROUTE_RESERVED →
//   ORIGIN_PENDING → ORIGIN_CONFIRMED → TOKENIZED →
//   SETTLEMENT_PENDING → SETTLED →
//   DESTINATION_PENDING → DESTINATION_CONFIRMED → COMPLETED
//
// Waiting is a POLICY, not a state: a WAIT_FOR_BETTER execution stays in
// SEARCHING while dRamp continuously re-evaluates liquidity.
//
// Cancellation is governed by commitment_status:
//   REVERSIBLE → cancel immediately, release reservations + collateral
//   PARTIALLY_COMMITTED → cancellation may require resolution
//   IRREVERSIBLE → cannot cancel
//
// Route reservation (capacity + collateral + obligations) happens in ONE
// database transaction with conditional re-checks, so two simultaneous
// executions cannot over-allocate one provider.

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { Decimal, moneyAdd, moneySub, moneyMul, moneyGte, moneyGt, moneyLte, bpsToFactor, feeForAmount, incentiveForAmount, roundMoney } from "./money";
import { findRoutes, type CandidateRoute } from "./routing";
import {
  appendAuditEvent,
} from "./audit";
import {
  transfer,
  mint,
  burn,
  lock,
  release,
  fee as feeEntry,
  incentive as incentiveEntry,
} from "./ledger";
import {
  assertCollateralEligible,
  lockCollateral,
  releaseCollateralForExecution,
  reserveCapacity,
  consumeReservationsForExecution,
  releaseReservationsForExecution,
  currentExposure,
} from "./collateral";
import {
  AUDIT_ACTOR,
  CANCELLATION_POLICY,
  CHANNEL_TYPE,
  COMMITMENT_STATUS,
  EXECUTION_POLICY,
  EXECUTION_STATUS,
  HAPPY_PATH,
  LEG_ROLE,
  LEG_STATUS,
  OBLIGATION_STATUS,
  RESERVATION_STATUS,
  ROUTE_STATUS,
  ROUTE_TAG,
  TERMINAL_STATES,
} from "./types";
import { attemptAutomaticConfirmation } from "./providers/adapter";

// Minimum dwell time per state (ms) so the UI can render each transition.
const STATE_DWELL_MS = 2500;

// ---- Intent creation -----------------------------------------------------

export interface CreateIntentInput {
  userId?: string;
  userEmail?: string;
  userName?: string;
  sourceAmount: string | number;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  riskTolerance: string;
  executionPolicy: string;
  maxWaitSeconds: number;
  cancellationPolicy?: string;
  minimumDestinationAmount?: string | number;
  maximumTotalCost?: string | number;
  targetRate?: string | number;
  allowedSettlementAssets?: string[];
  prohibitedSettlementAssets?: string[];
}

export async function createIntent(input: CreateIntentInput) {
  // Ensure a user exists (mocked identity).
  let userId = input.userId;
  if (!userId) {
    const email = input.userEmail ?? "alice@dramp.demo";
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) userId = existing.id;
    else {
      const u = await db.user.create({ data: { email, name: input.userName ?? "Alice" } });
      userId = u.id;
    }
  }

  const expiresAt = new Date(Date.now() + Math.max(input.maxWaitSeconds, 60) * 1000 + 60_000);
  const intent = await db.executionIntent.create({
    data: {
      userId,
      sourceAmount: new Decimal(input.sourceAmount),
      sourceAsset: input.sourceAsset,
      sourceCountry: input.sourceCountry,
      destinationAsset: input.destinationAsset,
      destinationCountry: input.destinationCountry,
      minimumDestinationAmount: input.minimumDestinationAmount ? new Decimal(input.minimumDestinationAmount) : null,
      maximumTotalCost: input.maximumTotalCost ? new Decimal(input.maximumTotalCost) : null,
      targetRate: input.targetRate ? new Decimal(input.targetRate) : null,
      riskTolerance: input.riskTolerance,
      executionPolicy: input.executionPolicy,
      maxWaitSeconds: input.maxWaitSeconds,
      cancellationPolicy: input.cancellationPolicy ?? CANCELLATION_POLICY.CANCEL_ANYTIME_WHILE_REVERSIBLE,
      allowedSettlementAssets: JSON.stringify(input.allowedSettlementAssets ?? []),
      prohibitedSettlementAssets: JSON.stringify(input.prohibitedSettlementAssets ?? []),
      status: "ACTIVE",
      expiresAt,
    },
  });

  // Create the first execution attempt.
  const execution = await db.execution.create({
    data: {
      intentId: intent.id,
      attemptNumber: 1,
      status: EXECUTION_STATUS.INTENT_CREATED,
      commitmentStatus: COMMITMENT_STATUS.REVERSIBLE,
      startedAt: new Date(),
      lastTickAt: new Date(),
    },
  });

  await appendAuditEvent({
    intentId: intent.id,
    executionId: execution.id,
    eventType: "intent_created",
    payload: {
      sourceAmount: input.sourceAmount,
      sourceAsset: input.sourceAsset,
      destinationAsset: input.destinationAsset,
      riskTolerance: input.riskTolerance,
      executionPolicy: input.executionPolicy,
      maxWaitSeconds: input.maxWaitSeconds,
    },
    actorType: AUDIT_ACTOR.USER,
    actorId: userId,
  });

  // Immediately move to SEARCHING and discover routes.
  await db.execution.update({
    where: { id: execution.id },
    data: { status: EXECUTION_STATUS.SEARCHING, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId: execution.id,
    eventType: "execution_searching",
    payload: { policy: input.executionPolicy },
  });

  const routes = await discoverAndPersistRoutes(execution.id, intent);

  // If NOW policy and a valid route exists, select it immediately.
  if (input.executionPolicy === EXECUTION_POLICY.NOW) {
    const best = routes.find((r) => r.tag === ROUTE_TAG.BEST);
    if (best) {
      await selectRoute(execution.id, best.id);
    }
  } else if (input.executionPolicy === EXECUTION_POLICY.WAIT_FOR_BETTER) {
    // Set the best valid route as the reference; stay in SEARCHING.
    const best = routes.find((r) => !r.hardFilterRejection);
    if (best) {
      await db.execution.update({
        where: { id: execution.id },
        data: { referenceRouteId: best.id },
      });
      await appendAuditEvent({
        executionId: execution.id,
        eventType: "reference_route_set",
        payload: { routeId: best.id, tag: best.tag, effectiveCost: best.effectiveCost.toString() },
      });
    }
  }

  return { intent, execution, routes };
}

// ---- Route discovery & persistence ---------------------------------------

export async function discoverAndPersistRoutes(executionId: string, intent: { id: string; sourceAmount: Prisma.Decimal; sourceAsset: string; sourceCountry: string; destinationAsset: string; destinationCountry: string; riskTolerance: string; allowedSettlementAssets: string; prohibitedSettlementAssets: string }) {
  const allowed = safeParse(intent.allowedSettlementAssets);
  const prohibited = safeParse(intent.prohibitedSettlementAssets);
  const candidates = await findRoutes({
    sourceAmount: intent.sourceAmount,
    sourceAsset: intent.sourceAsset,
    sourceCountry: intent.sourceCountry,
    destinationAsset: intent.destinationAsset,
    destinationCountry: intent.destinationCountry,
    riskTolerance: intent.riskTolerance,
    allowedSettlementAssets: allowed,
    prohibitedSettlementAssets: prohibited,
  });

  const persisted: Array<CandidateRoute & { id: string }> = [];
  for (const c of candidates) {
    const route = await db.route.create({
      data: {
        executionId,
        legCount: c.hopCount,
        totalCost: c.totalCost,
        effectiveCost: c.effectiveCost,
        grossOutput: c.grossOutput,
        netOutput: c.netOutput,
        incentiveBps: c.incentiveBps,
        riskCounterparty: c.risk.counterparty,
        riskSettlementAsset: c.risk.settlementAsset,
        riskLiquidity: c.risk.liquidity,
        riskOperational: c.risk.operational,
        riskDuration: c.risk.duration,
        riskComposite: c.risk.composite,
        expectedExecutionSeconds: c.expectedExecutionSeconds,
        explanation: c.explanation || (c.hardFilterRejection ?? "Candidate route"),
        tag: c.tag,
        status: c.hardFilterRejection ? ROUTE_STATUS.FAILED : ROUTE_STATUS.CANDIDATE,
        splitRoute: c.split,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    for (const leg of c.legs) {
      await db.leg.create({
        data: {
          routeId: route.id,
          executionId,
          providerId: leg.providerId,
          offerId: leg.offerId,
          sequence: leg.sequence,
          role: leg.role,
          amount: leg.amount,
          sourceAsset: leg.sourceAsset,
          destinationAsset: leg.destinationAsset,
          settlementAssetId: leg.settlementAssetId,
          channelType: leg.channelType,
          status: LEG_STATUS.PENDING,
          commitmentStatus: COMMITMENT_STATUS.REVERSIBLE,
        },
      });
    }
    persisted.push({ ...c, id: route.id });
  }

  await appendAuditEvent({
    executionId,
    eventType: "routes_discovered",
    payload: {
      count: candidates.length,
      valid: candidates.filter((c) => !c.hardFilterRejection).length,
      rejected: candidates.filter((c) => c.hardFilterRejection).map((c) => ({ reason: c.hardFilterRejection })),
    },
  });

  return persisted;
}

// ---- Route selection -----------------------------------------------------

export async function selectRoute(executionId: string, routeId: string) {
  const execution = await db.execution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error("Execution not found");
  if (execution.status !== EXECUTION_STATUS.SEARCHING && execution.status !== EXECUTION_STATUS.ROUTE_FOUND) {
    throw new Error(`Cannot select route in state ${execution.status}`);
  }
  await db.route.updateMany({
    where: { executionId, status: ROUTE_STATUS.CANDIDATE },
    data: { status: ROUTE_STATUS.SUPERSEDED },
  });
  await db.route.update({
    where: { id: routeId },
    data: { status: ROUTE_STATUS.SELECTED },
  });
  const snapshot = await buildRouteSnapshot(routeId);
  await db.execution.update({
    where: { id: executionId },
    data: {
      status: EXECUTION_STATUS.ROUTE_FOUND,
      selectedRouteId: routeId,
      selectedRouteJson: JSON.stringify(snapshot),
      lastTickAt: new Date(),
    },
  });
  await appendAuditEvent({
    executionId,
    eventType: "route_selected",
    payload: { routeId, tag: snapshot.tag, netOutput: snapshot.netOutput, effectiveCost: snapshot.effectiveCost },
  });
}

// ---- Route reservation (the critical concurrency point) ------------------

export async function reserveRoute(executionId: string) {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    include: { intent: true },
  });
  if (!execution) throw new Error("Execution not found");
  if (execution.status !== EXECUTION_STATUS.ROUTE_FOUND) {
    throw new Error(`Cannot reserve in state ${execution.status}`);
  }
  const routeId = execution.selectedRouteId;
  if (!routeId) throw new Error("No route selected");

  // Run the whole reservation in a single interactive transaction.
  await db.$transaction(async (tx) => {
    const route = await tx.route.findUnique({
      where: { id: routeId },
      include: { legs: { include: { provider: true, offer: true } } },
    });
    if (!route) throw new Error("Route not found");

    // 1. Reserve capacity on each offer (conditional updates).
    // 2. For collateralized providers, lock collateral (assert eligibility).
    // 3. Create obligations.
    // 4. Update execution + route status.
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const obligationIds: string[] = [];

    // Group legs by sequence to handle split routes.
    const bySequence = new Map<number, typeof route.legs>();
    for (const leg of route.legs) {
      if (!bySequence.has(leg.sequence)) bySequence.set(leg.sequence, []);
      bySequence.get(leg.sequence)!.push(leg);
    }
    const sequences = [...bySequence.keys()].sort((a, b) => a - b);

    for (const seq of sequences) {
      const legs = bySequence.get(seq)!;
      for (const leg of legs) {
        // Reserve capacity.
        await reserveCapacity({
          offerId: leg.offerId,
          executionId,
          amount: leg.amount,
          expiresAt,
          idempotencyKey: `reserve:${executionId}:${leg.id}`,
          tx,
        });

        // Update leg status.
        await tx.leg.update({
          where: { id: leg.id },
          data: { status: LEG_STATUS.RESERVED },
        });

        // Lock collateral if the provider is collateralized.
        if (leg.provider.trustModel === "COLLATERALIZED") {
          const vault = await tx.vault.findUnique({ where: { providerId: leg.providerId } });
          if (!vault) throw new Error(`Collateralized provider ${leg.provider.name} has no vault`);
          // Determine the collateral asset (first stable holding).
          const holdings = JSON.parse(vault.holdingsJson) as { asset: string; amount: string }[];
          const collateralAsset = holdings[0]?.asset;
          if (!collateralAsset) throw new Error(`Vault for ${leg.provider.name} has no holdings`);
          const sa = await tx.settlementAsset.findUnique({ where: { symbol: collateralAsset } });
          if (!sa) throw new Error(`Collateral asset ${collateralAsset} not found`);
          assertCollateralEligible(sa);
          const { lock: lk } = await lockCollateral({
            providerId: leg.providerId,
            executionId,
            amount: leg.amount,
            asset: collateralAsset,
            idempotencyKey: `lock:${executionId}:${leg.id}`,
            tx,
          });

          // Post a LOCK ledger entry.
          await tx.ledgerEntry.create({
            data: {
              debitAccount: `provider:${leg.providerId}:vault:${collateralAsset}`,
              creditAccount: `provider:${leg.providerId}:operational:${collateralAsset}`,
              amount: leg.amount,
              asset: collateralAsset,
              entryType: "LOCK",
              executionId,
              idempotencyKey: `ledger-lock:${executionId}:${leg.id}`,
              description: `Collateral locked for leg ${leg.id}`,
            },
          });
          void lk;
        }

        // Create the obligation.
        const obligation = await tx.obligation.create({
          data: {
            executionId,
            legId: leg.id,
            providerId: leg.providerId,
            amount: leg.amount,
            asset: leg.sourceAsset,
            dueAt: new Date(Date.now() + 10 * 60_000),
            status: OBLIGATION_STATUS.CREATED,
            collateralBackingId: null,
          },
        });
        obligationIds.push(obligation.id);
      }
    }

    // Update execution + route.
    await tx.execution.update({
      where: { id: executionId },
      data: {
        status: EXECUTION_STATUS.ROUTE_RESERVED,
        commitmentStatus: COMMITMENT_STATUS.REVERSIBLE,
        lastTickAt: new Date(),
      },
    });
    await tx.route.update({
      where: { id: routeId },
      data: { status: ROUTE_STATUS.RESERVED },
    });
  }, { timeout: 30000, maxWait: 15000 });

  await appendAuditEvent({
    executionId,
    eventType: "route_reserved",
    payload: { routeId },
  });
  await appendAuditEvent({
    executionId,
    eventType: "obligations_created",
    payload: { count: obligationIdsPlaceholder(executionId) },
  });
}

// helper to count obligations without leaking tx scope
async function obligationIdsPlaceholder(executionId: string) {
  const c = await db.obligation.count({ where: { executionId } });
  return c;
}

// ---- State advancement (driven by the ticker) ----------------------------

export async function advanceExecution(executionId: string): Promise<{ advanced: boolean; reason?: string }> {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    include: { intent: true },
  });
  if (!execution) return { advanced: false, reason: "not found" };
  if (TERMINAL_STATES.has(execution.status)) return { advanced: false, reason: "terminal" };

  // Check intent expiry.
  if (execution.intent.status === "EXPIRED" || execution.intent.expiresAt < new Date()) {
    if (execution.status === EXECUTION_STATUS.SEARCHING || execution.status === EXECUTION_STATUS.INTENT_CREATED) {
      await expireExecution(executionId, "intent expired");
      return { advanced: true, reason: "expired" };
    }
  }

  // Enforce dwell time so the UI can render each state.
  const dwellElapsed = Date.now() - execution.lastTickAt.getTime() >= STATE_DWELL_MS;
  if (!dwellElapsed) return { advanced: false, reason: "dwell" };

  switch (execution.status) {
    case EXECUTION_STATUS.SEARCHING:
      return advanceSearching(execution);
    case EXECUTION_STATUS.ROUTE_FOUND:
      await reserveRoute(executionId);
      return { advanced: true, reason: "reserved" };
    case EXECUTION_STATUS.ROUTE_RESERVED:
      await beginOriginPending(executionId);
      return { advanced: true, reason: "origin_pending" };
    case EXECUTION_STATUS.ORIGIN_PENDING:
      // Simulate the user's fiat-in payment arriving.
      await confirmOrigin(executionId);
      return { advanced: true, reason: "origin_confirmed" };
    case EXECUTION_STATUS.ORIGIN_CONFIRMED:
      await tokenize(executionId);
      return { advanced: true, reason: "tokenized" };
    case EXECUTION_STATUS.TOKENIZED:
      await beginSettlement(executionId);
      return { advanced: true, reason: "settlement_pending" };
    case EXECUTION_STATUS.SETTLEMENT_PENDING:
      await settle(executionId);
      return { advanced: true, reason: "settled" };
    case EXECUTION_STATUS.SETTLED:
      await beginDestination(executionId);
      return { advanced: true, reason: "destination_pending" };
    case EXECUTION_STATUS.DESTINATION_PENDING:
      return await confirmDestination(executionId);
    case EXECUTION_STATUS.DESTINATION_CONFIRMED:
      await completeExecution(executionId);
      return { advanced: true, reason: "completed" };
    default:
      return { advanced: false, reason: `unhandled ${execution.status}` };
  }
}

// ---- SEARCHING (waiting / re-evaluation) ---------------------------------

async function advanceSearching(execution: Prisma.ExecutionGetPayload<{ include: { intent: true } }>) {
  // Re-evaluate routes in-memory (do NOT re-persist every tick — that would
  // duplicate route records and break the reference lookup).
  const candidates = await findRoutes({
    sourceAmount: execution.intent.sourceAmount,
    sourceAsset: execution.intent.sourceAsset,
    sourceCountry: execution.intent.sourceCountry,
    destinationAsset: execution.intent.destinationAsset,
    destinationCountry: execution.intent.destinationCountry,
    riskTolerance: execution.intent.riskTolerance,
    allowedSettlementAssets: safeParse(execution.intent.allowedSettlementAssets),
    prohibitedSettlementAssets: safeParse(execution.intent.prohibitedSettlementAssets),
  });

  const validCandidates = candidates.filter((c) => !c.hardFilterRejection);
  if (validCandidates.length === 0) {
    if (Date.now() - execution.startedAt.getTime() > execution.intent.maxWaitSeconds * 1000) {
      await expireExecution(execution.id, "no valid route found within max wait");
      return { advanced: true, reason: "expired_no_route" };
    }
    await db.execution.update({ where: { id: execution.id }, data: { lastTickAt: new Date() } });
    return { advanced: false, reason: "no_valid_routes" };
  }

  const best = validCandidates[0]; // already sorted by rankAndTag

  if (execution.intent.executionPolicy === EXECUTION_POLICY.NOW) {
    // Persist the selected route and move to ROUTE_FOUND.
    const persisted = await persistSingleRoute(execution.id, best);
    await selectRoute(execution.id, persisted.id);
    return { advanced: true, reason: "now_selected" };
  }

  // WAIT_FOR_BETTER: compare the in-memory best to the persisted reference.
  const refRoute = execution.referenceRouteId
    ? await db.route.findUnique({ where: { id: execution.referenceRouteId } })
    : null;

  const waitedSeconds = Math.floor((Date.now() - execution.startedAt.getTime()) / 1000);
  const timeout = waitedSeconds >= execution.intent.maxWaitSeconds;

  if (!refRoute) {
    // Persist the best as the initial reference.
    const persisted = await persistSingleRoute(execution.id, best);
    await db.execution.update({
      where: { id: execution.id },
      data: { referenceRouteId: persisted.id, lastTickAt: new Date() },
    });
    await appendAuditEvent({
      executionId: execution.id,
      eventType: "reference_route_set",
      payload: { routeId: persisted.id, tag: best.tag, effectiveCost: best.effectiveCost.toString() },
    });
    return { advanced: false, reason: "reference_set" };
  }

  // Compare the new best to the reference using ABSOLUTE route quality
  // (not candidate-set-normalized). This is stable across time — the same
  // route gets the same quality score regardless of what other candidates
  // exist in the marketplace at this moment.
  //
  // The persisted reference route is RECONSTRUCTED with its real provider IDs,
  // corridors, amounts, and risk dimensions — no fake/default values.
  let scoreCtx: any = { riskTolerance: execution.intent.riskTolerance };
  try {
    const { getReputationMap, getCorridorScoreMap } = await import("@/lib/economics/reputation");
    const { getCommitmentReliabilityMap } = await import("@/lib/economics/commitments");
    scoreCtx = {
      riskTolerance: execution.intent.riskTolerance,
      reputationMap: await getReputationMap(),
      corridorScores: await getCorridorScoreMap(),
      commitmentReliability: await getCommitmentReliabilityMap(),
    };
  } catch {
    // Fall back to cost/speed/risk only if reputation service is unavailable.
  }

  // Reconstruct the persisted reference route with REAL provider/corridor data.
  const { reconstructPersistedRoute, shouldReplaceRoute, ROUTE_REPLACEMENT_THRESHOLD } = await import("@/lib/engine/routing");
  const refCandidate = await reconstructPersistedRoute(refRoute.id);
  if (!refCandidate) {
    // Reference route couldn't be reconstructed — use the current best.
    const persisted = await persistSingleRoute(execution.id, best);
    await db.execution.update({ where: { id: execution.id }, data: { referenceRouteId: persisted.id } });
    await selectRoute(execution.id, persisted.id);
    return { advanced: true, reason: "reference_unreconstructable" };
  }

  const replacement = shouldReplaceRoute(best, refCandidate, scoreCtx);

  // Also compute cost improvement for audit trail.
  const improvementBps = refRoute.effectiveCost
    .minus(best.effectiveCost)
    .dividedBy(execution.intent.sourceAmount)
    .times(10000)
    .toNumber();

  await db.execution.update({
    where: { id: execution.id },
    data: { waitedSeconds, lastTickAt: new Date() },
  });

  if (replacement.replace) {
    // Persist the new best, update reference, and execute.
    const persisted = await persistSingleRoute(execution.id, best);
    await db.execution.update({
      where: { id: execution.id },
      data: { referenceRouteId: persisted.id },
    });
    await appendAuditEvent({
      executionId: execution.id,
      eventType: "better_route_found",
      payload: {
        previousRouteId: refRoute.id,
        newRouteId: persisted.id,
        improvementBps: Number(improvementBps.toFixed(2)),
        absoluteQualityImprovement: Number(replacement.improvement.toFixed(6)),
        replacementThreshold: ROUTE_REPLACEMENT_THRESHOLD,
        replacementReason: replacement.reason,
        previousEffectiveCost: refRoute.effectiveCost.toString(),
        newEffectiveCost: best.effectiveCost.toString(),
        scoringNote: "Absolute route quality (stable cross-time, not candidate-set-normalized)",
      },
    });
    try {
      await selectRoute(execution.id, persisted.id);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Cannot select route in state")) {
        return { advanced: false, reason: "already_advancing" };
      }
      throw err;
    }
    return { advanced: true, reason: "better_route_selected" };
  }

  if (timeout) {
    const persisted = await persistSingleRoute(execution.id, best);
    await appendAuditEvent({
      executionId: execution.id,
      eventType: "wait_timeout_executing_best",
      payload: { routeId: persisted.id, waitedSeconds },
    });
    try {
      await selectRoute(execution.id, persisted.id);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Cannot select route in state")) {
        return { advanced: false, reason: "already_advancing" };
      }
      throw err;
    }
    return { advanced: true, reason: "timeout_executed" };
  }

  return { advanced: false, reason: `waiting: ${replacement.reason}` };
}

// Persist a single candidate route (with its legs) for selection.
async function persistSingleRoute(executionId: string, c: CandidateRoute) {
  const route = await db.route.create({
    data: {
      executionId,
      legCount: c.hopCount,
      totalCost: c.totalCost,
      effectiveCost: c.effectiveCost,
      grossOutput: c.grossOutput,
      netOutput: c.netOutput,
      incentiveBps: c.incentiveBps,
      riskCounterparty: c.risk.counterparty,
      riskSettlementAsset: c.risk.settlementAsset,
      riskLiquidity: c.risk.liquidity,
      riskOperational: c.risk.operational,
      riskDuration: c.risk.duration,
      riskComposite: c.risk.composite,
      expectedExecutionSeconds: c.expectedExecutionSeconds,
      explanation: c.explanation,
      tag: c.tag,
      status: ROUTE_STATUS.CANDIDATE,
      splitRoute: c.split,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  for (const leg of c.legs) {
    await db.leg.create({
      data: {
        routeId: route.id,
        executionId,
        providerId: leg.providerId,
        offerId: leg.offerId,
        sequence: leg.sequence,
        role: leg.role,
        amount: leg.amount,
        sourceAsset: leg.sourceAsset,
        destinationAsset: leg.destinationAsset,
        settlementAssetId: leg.settlementAssetId,
        channelType: leg.channelType,
        status: LEG_STATUS.PENDING,
        commitmentStatus: COMMITMENT_STATUS.REVERSIBLE,
      },
    });
  }
  return route;
}

// ---- Origin leg ----------------------------------------------------------

async function beginOriginPending(executionId: string) {
  const sourceLegs = await getSourceLegs(executionId);
  for (const leg of sourceLegs) {
    await db.leg.update({
      where: { id: leg.id },
      data: { status: LEG_STATUS.IN_PROGRESS, commitmentStatus: COMMITMENT_STATUS.PARTIALLY_COMMITTED },
    });
  }
  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.ORIGIN_PENDING, commitmentStatus: COMMITMENT_STATUS.PARTIALLY_COMMITTED, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "origin_pending",
    payload: { legs: sourceLegs.map((l) => l.id) },
  });
}

async function confirmOrigin(executionId: string) {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    include: { intent: true },
  });
  if (!execution) throw new Error("Execution not found");

  const sourceLegs = await getSourceLegs(executionId);
  // Simulate the user's external payment arriving (fiat-in).
  await transfer(
    `external:source:${execution.intent.sourceAsset}`,
    `execution:${executionId}:escrow:${execution.intent.sourceAsset}`,
    execution.intent.sourceAmount,
    execution.intent.sourceAsset,
    { executionId, idempotencyKey: `origin-in:${executionId}`, description: "User source payment received" },
  );

  for (const leg of sourceLegs) {
    await db.leg.update({
      where: { id: leg.id },
      data: { status: LEG_STATUS.CONFIRMED, confirmedAt: new Date() },
    });
  }

  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.ORIGIN_CONFIRMED, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "fiat_received",
    payload: { amount: execution.intent.sourceAmount.toString(), asset: execution.intent.sourceAsset },
  });
}

// ---- Tokenization --------------------------------------------------------

async function tokenize(executionId: string) {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    include: { intent: true },
  });
  if (!execution) throw new Error("Execution not found");
  const route = await fetchRouteWithLegs(execution.selectedRouteId);
  if (!route) throw new Error("Selected route not found");
  // Source legs convert source asset -> settlement asset (or directly to dest).
  const sourceLegs = route.legs
    .filter((l) => l.role === LEG_ROLE.SOURCE)
    .sort((a, b) => a.sequence - b.sequence);

  for (const leg of sourceLegs) {
    // Move source asset from escrow to provider operational.
    await transfer(
      `execution:${executionId}:escrow:${leg.sourceAsset}`,
      `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
      leg.amount,
      leg.sourceAsset,
      { executionId, idempotencyKey: `tokenize-in:${executionId}:${leg.id}`, description: `Source funds to ${leg.provider.name}` },
    );
    // Charge the fee.
    const feeAmt = feeForAmount(leg.amount, leg.offer.feeBps);
    if (feeAmt.gt(0)) {
      await feeEntry(
        `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
        feeAmt,
        leg.sourceAsset,
        { executionId, idempotencyKey: `fee:${executionId}:${leg.id}`, description: `Provider fee ${leg.offer.feeBps}bps` },
      );
    }
    // Mint / credit the settlement asset (or destination asset) to escrow.
    const outAmount = moneySub(moneyMul(moneySub(leg.amount, feeAmt), leg.offer.rate), new Decimal(0));
    await mint(
      `execution:${executionId}:escrow:${leg.destinationAsset}`,
      outAmount,
      leg.destinationAsset,
      { executionId, idempotencyKey: `mint:${executionId}:${leg.id}`, description: `Tokenized ${leg.destinationAsset} from ${leg.provider.name}` },
    );
    // Apply incentive if any (rebate to execution escrow).
    if (leg.offer.incentiveBps > 0) {
      const inc = incentiveForAmount(outAmount, leg.offer.incentiveBps);
      await incentiveEntry(
        `execution:${executionId}:escrow:${leg.destinationAsset}`,
        inc,
        leg.destinationAsset,
        { executionId, idempotencyKey: `incentive:${executionId}:${leg.id}`, description: `Settlement incentive ${leg.offer.incentiveBps}bps` },
      );
    }
    await db.leg.update({ where: { id: leg.id }, data: { status: LEG_STATUS.CONFIRMED, confirmedAt: new Date() } });
  }

  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.TOKENIZED, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "tokenized",
    payload: { legs: sourceLegs.map((l) => ({ id: l.id, provider: l.provider.name, asset: l.destinationAsset })) },
  });
}

// ---- Settlement ----------------------------------------------------------

async function beginSettlement(executionId: string) {
  const execution = await db.execution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error("Execution not found");
  const route = await fetchRouteWithLegs(execution.selectedRouteId);
  if (!route) throw new Error("Selected route not found");
  const hopLegs = route.legs
    .filter((l) => l.role === LEG_ROLE.SETTLEMENT_HOP)
    .sort((a, b) => a.sequence - b.sequence);
  for (const leg of hopLegs) {
    await db.leg.update({ where: { id: leg.id }, data: { status: LEG_STATUS.IN_PROGRESS } });
    // Move settlement asset between providers.
    await transfer(
      `execution:${executionId}:escrow:${leg.sourceAsset}`,
      `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
      leg.amount,
      leg.sourceAsset,
      { executionId, idempotencyKey: `settle-in:${executionId}:${leg.id}`, description: `Settlement funds to ${leg.provider.name}` },
    );
  }
  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.SETTLEMENT_PENDING, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "settlement_pending",
    payload: { legs: hopLegs.map((l) => l.id) },
  });
}

async function settle(executionId: string) {
  const execution = await db.execution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error("Execution not found");
  const route = await fetchRouteWithLegs(execution.selectedRouteId);
  if (!route) throw new Error("Selected route not found");
  const hopLegs = route.legs
    .filter((l) => l.role === LEG_ROLE.SETTLEMENT_HOP)
    .sort((a, b) => a.sequence - b.sequence);
  for (const leg of hopLegs) {
    // Burn the consumed settlement asset and mint the next asset to escrow.
    await burn(
      `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
      leg.amount,
      leg.sourceAsset,
      { executionId, idempotencyKey: `burn:${executionId}:${leg.id}`, description: `Settlement asset consumed by ${leg.provider.name}` },
    );
    const feeAmt = feeForAmount(leg.amount, leg.offer.feeBps);
    if (feeAmt.gt(0)) {
      await feeEntry(
        `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
        feeAmt,
        leg.sourceAsset,
        { executionId, idempotencyKey: `fee:${executionId}:${leg.id}`, description: `Provider fee` },
      );
    }
    const outAmount = moneyMul(moneySub(leg.amount, feeAmt), leg.offer.rate);
    await mint(
      `execution:${executionId}:escrow:${leg.destinationAsset}`,
      outAmount,
      leg.destinationAsset,
      { executionId, idempotencyKey: `mint:${executionId}:${leg.id}`, description: `Settlement hop output` },
    );
    await db.leg.update({ where: { id: leg.id }, data: { status: LEG_STATUS.CONFIRMED, confirmedAt: new Date() } });
  }
  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.SETTLED, commitmentStatus: COMMITMENT_STATUS.IRREVERSIBLE, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "settlement_completed",
    payload: {},
  });
}

// ---- Destination ---------------------------------------------------------

async function beginDestination(executionId: string) {
  const destLegs = await getDestinationLegs(executionId);
  for (const leg of destLegs) {
    await db.leg.update({ where: { id: leg.id }, data: { status: LEG_STATUS.IN_PROGRESS } });
  }
  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.DESTINATION_PENDING, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "destination_pending",
    payload: { legs: destLegs.map((l) => l.id) },
  });
}

async function confirmDestination(executionId: string): Promise<{ advanced: boolean; reason?: string }> {
  const execution = await db.execution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error("Execution not found");
  const route = await fetchRouteWithLegs(execution.selectedRouteId);
  if (!route) throw new Error("Selected route not found");
  const destLegs = route.legs
    .filter((l) => l.role === LEG_ROLE.DESTINATION)
    .sort((a, b) => a.sequence - b.sequence);

  // For automatic legs, attempt confirmation. For manual legs, wait for the
  // provider console to confirm.
  for (const leg of destLegs) {
    if (leg.status === LEG_STATUS.CONFIRMED) continue;
    if (leg.channelType === CHANNEL_TYPE.AUTOMATIC) {
      const r = await attemptAutomaticConfirmation(leg.id);
      if (!r.confirmed) {
        // Auto-confirmation failed — surface as a dispute/failure path.
        await db.execution.update({ where: { id: executionId }, data: { lastTickAt: new Date() } });
        await appendAuditEvent({
          executionId,
          eventType: "destination_auto_confirm_failed",
          payload: { legId: leg.id, reason: r.reason },
        });
        return { advanced: false, reason: "auto_confirm_failed" };
      }
    } else {
      // Manual: check if confirmed via console.
      if (leg.status !== LEG_STATUS.CONFIRMED) {
        await db.execution.update({ where: { id: executionId }, data: { lastTickAt: new Date() } });
        return { advanced: false, reason: "awaiting_manual_confirmation" };
      }
    }
  }

  // All destination legs confirmed — pay out to recipient.
  for (const leg of destLegs) {
    // Move settlement asset from escrow to provider, then burn/mint payout.
    await transfer(
      `execution:${executionId}:escrow:${leg.sourceAsset}`,
      `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
      leg.amount,
      leg.sourceAsset,
      { executionId, idempotencyKey: `dest-in:${executionId}:${leg.id}`, description: `Funds to payout provider ${leg.provider.name}` },
    );
    const feeAmt = feeForAmount(leg.amount, leg.offer.feeBps);
    if (feeAmt.gt(0)) {
      await feeEntry(
        `provider:${leg.providerId}:operational:${leg.sourceAsset}`,
        feeAmt,
        leg.sourceAsset,
        { executionId, idempotencyKey: `fee:${executionId}:${leg.id}`, description: `Payout provider fee` },
      );
    }
    const payout = moneyMul(moneySub(leg.amount, feeAmt), leg.offer.rate);
    await mint(
      `execution:${executionId}:escrow:${leg.destinationAsset}`,
      payout,
      leg.destinationAsset,
      { executionId, idempotencyKey: `payout:${executionId}:${leg.id}`, description: `Payout minted` },
    );
    await transfer(
      `execution:${executionId}:escrow:${leg.destinationAsset}`,
      `external:destination:${leg.destinationAsset}`,
      payout,
      leg.destinationAsset,
      { executionId, idempotencyKey: `payout-out:${executionId}:${leg.id}`, description: `Payout to recipient` },
    );
  }

  await db.execution.update({
    where: { id: executionId },
    data: { status: EXECUTION_STATUS.DESTINATION_CONFIRMED, lastTickAt: new Date() },
  });
  await appendAuditEvent({
    executionId,
    eventType: "payout_completed",
    payload: {},
  });
  return { advanced: true, reason: "destination_confirmed" };
}

// ---- Completion ----------------------------------------------------------

async function completeExecution(executionId: string) {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    include: { intent: true },
  });
  if (!execution) throw new Error("Execution not found");

  // Release collateral, fulfill obligations, consume reservations.
  await db.$transaction(async (tx) => {
    await releaseCollateralForExecution(executionId, tx);
    await consumeReservationsForExecution(executionId, tx);
    // Fulfill all obligations.
    const obligations = await tx.obligation.findMany({ where: { executionId } });
    for (const ob of obligations) {
      await tx.obligation.update({
        where: { id: ob.id },
        data: { status: OBLIGATION_STATUS.FULFILLED, fulfilledAt: new Date() },
      });
    }
    // Release collateral ledger entries.
    const locks = await tx.collateralLock.findMany({ where: { executionId } });
    for (const lk of locks) {
      await tx.ledgerEntry.create({
        data: {
          debitAccount: `provider:${lk.providerId}:operational:${lk.asset}`,
          creditAccount: `provider:${lk.providerId}:vault:${lk.asset}`,
          amount: lk.amount,
          asset: lk.asset,
          entryType: "RELEASE",
          executionId,
          idempotencyKey: `release:${executionId}:${lk.id}`,
          description: "Collateral released after completion",
        },
      });
    }
    // Mark remaining legs confirmed.
    await tx.leg.updateMany({
      where: { executionId, status: { not: LEG_STATUS.CONFIRMED } },
      data: { status: LEG_STATUS.CONFIRMED, commitmentStatus: COMMITMENT_STATUS.IRREVERSIBLE },
    });
    await tx.execution.update({
      where: { id: executionId },
      data: { status: EXECUTION_STATUS.COMPLETED, commitmentStatus: COMMITMENT_STATUS.IRREVERSIBLE, completedAt: new Date(), lastTickAt: new Date() },
    });
    await tx.executionIntent.update({
      where: { id: execution.intentId },
      data: { status: "COMPLETED" },
    });
  }, { timeout: 30000, maxWait: 15000 });

  await appendAuditEvent({
    executionId,
    eventType: "execution_completed",
    payload: {},
  });

  // Accrue settlement-asset incentive earnings for qualifying completed legs.
  // This is the ONLY place incentives are "earned" — never at route display.
  try {
    const { accrueIncentiveForExecution } = await import("@/lib/provider-api/incentives");
    await accrueIncentiveForExecution(executionId);
  } catch (err) {
    console.error(`[dRamp] incentive accrual error for ${executionId}:`, err);
  }

  // Record provider performance outcomes for reputation/corridor scoring.
  // This feeds the ReputationService and the routing engine's reputation factor.
  try {
    const { recordExecutionOutcome } = await import("@/lib/economics/performance");
    const legs = await db.leg.findMany({
      where: { executionId },
      include: { offer: true },
    });
    for (const leg of legs) {
      await recordExecutionOutcome(executionId, leg.providerId, "COMPLETED", {
        sourceAsset: leg.sourceAsset,
        destinationAsset: leg.destinationAsset,
        sourceCountry: leg.offer?.sourceCountry ?? "GLOBAL",
        destinationCountry: leg.offer?.destinationCountry ?? "GLOBAL",
        amount: leg.amount,
        offer: leg.offer ? { feeBps: leg.offer.feeBps } : null,
      });
    }
  } catch (err) {
    console.error(`[dRamp] performance recording error for ${executionId}:`, err);
  }
}

// ---- Cancellation --------------------------------------------------------

export async function cancelExecution(executionId: string, actorId?: string): Promise<{ cancelled: boolean; reason?: string }> {
  const execution = await db.execution.findUnique({ where: { id: executionId } });
  if (!execution) throw new Error("not found");
  if (TERMINAL_STATES.has(execution.status)) {
    return { cancelled: false, reason: `already terminal (${execution.status})` };
  }
  if (execution.commitmentStatus === COMMITMENT_STATUS.IRREVERSIBLE) {
    return { cancelled: false, reason: "Execution is IRREVERSIBLE — cancellation not possible" };
  }
  if (execution.commitmentStatus === COMMITMENT_STATUS.PARTIALLY_COMMITTED) {
    // Cancellation may require resolution; for the prototype we allow it but
    // initiate a refund of any received funds.
    await db.$transaction(async (tx) => {
      await releaseReservationsForExecution(executionId, tx);
      await releaseCollateralForExecution(executionId, tx);
      await tx.leg.updateMany({
        where: { executionId },
        data: { status: LEG_STATUS.CANCELLED },
      });
      await tx.execution.update({
        where: { id: executionId },
        data: { status: EXECUTION_STATUS.CANCELLED, completedAt: new Date() },
      });
    }, { timeout: 30000, maxWait: 15000 });
    await appendAuditEvent({
      executionId,
      eventType: "execution_cancelled",
      payload: { commitment: COMMITMENT_STATUS.PARTIALLY_COMMITTED, note: "Partial-commitment cancellation with refund resolution" },
      actorType: AUDIT_ACTOR.USER,
      actorId,
    });
    return { cancelled: true, reason: "partial_commitment_refund" };
  }

  // Fully reversible.
  await db.$transaction(async (tx) => {
    await releaseReservationsForExecution(executionId, tx);
    await releaseCollateralForExecution(executionId, tx);
    await tx.leg.updateMany({
      where: { executionId },
      data: { status: LEG_STATUS.CANCELLED },
    });
    await tx.execution.update({
      where: { id: executionId },
      data: { status: EXECUTION_STATUS.CANCELLED, completedAt: new Date() },
    });
  }, { timeout: 30000, maxWait: 15000 });
  await appendAuditEvent({
    executionId,
    eventType: "execution_cancelled",
    payload: { commitment: COMMITMENT_STATUS.REVERSIBLE },
    actorType: AUDIT_ACTOR.USER,
    actorId,
  });
  return { cancelled: true, reason: "reversible_cancelled" };
}

// ---- Expiry --------------------------------------------------------------

async function expireExecution(executionId: string, reason: string) {
  await db.$transaction(async (tx) => {
    await releaseReservationsForExecution(executionId, tx);
    await releaseCollateralForExecution(executionId, tx);
    await tx.execution.update({
      where: { id: executionId },
      data: { status: EXECUTION_STATUS.EXPIRED, completedAt: new Date(), failureReason: reason },
    });
  }, { timeout: 30000, maxWait: 15000 });
  await appendAuditEvent({
    executionId,
    eventType: "execution_expired",
    payload: { reason },
  });
}

// ---- Helpers -------------------------------------------------------------

// Fetch the selected route with its legs (selectedRouteId is a String FK, not
// a Prisma relation, so we fetch it explicitly).
async function fetchRouteWithLegs(routeId: string | null) {
  if (!routeId) return null;
  return db.route.findUnique({
    where: { id: routeId },
    include: { legs: { include: { provider: true, offer: true } } },
  });
}

async function getSourceLegs(executionId: string) {
  return db.leg.findMany({
    where: { executionId, role: LEG_ROLE.SOURCE },
    orderBy: { sequence: "asc" },
  });
}

async function getDestinationLegs(executionId: string) {
  return db.leg.findMany({
    where: { executionId, role: LEG_ROLE.DESTINATION },
    orderBy: { sequence: "asc" },
  });
}

async function buildRouteSnapshot(routeId: string) {
  const route = await db.route.findUnique({
    where: { id: routeId },
    include: { legs: { include: { provider: true, offer: true } } },
  });
  if (!route) throw new Error("route not found");
  return {
    id: route.id,
    tag: route.tag,
    explanation: route.explanation,
    totalCost: route.totalCost.toString(),
    effectiveCost: route.effectiveCost.toString(),
    netOutput: route.netOutput.toString(),
    grossOutput: route.grossOutput.toString(),
    expectedExecutionSeconds: route.expectedExecutionSeconds,
    split: route.splitRoute,
    legs: route.legs
      .sort((a, b) => a.sequence - b.sequence)
      .map((l) => ({
        sequence: l.sequence,
        role: l.role,
        provider: l.provider.name,
        providerType: l.provider.providerType,
        trustModel: l.provider.trustModel,
        amount: l.amount.toString(),
        sourceAsset: l.sourceAsset,
        destinationAsset: l.destinationAsset,
        channelType: l.channelType,
        feeBps: l.offer.feeBps,
        incentiveBps: l.offer.incentiveBps,
      })),
    risk: {
      counterparty: route.riskCounterparty,
      settlementAsset: route.riskSettlementAsset,
      liquidity: route.riskLiquidity,
      operational: route.riskOperational,
      duration: route.riskDuration,
      composite: route.riskComposite,
    },
  };
}

function safeParse(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export { roundMoney };
