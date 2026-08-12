// Background engine ticker — runs continuously in the dev server process.
// Responsibilities:
//   1. Fire scheduled MarketSignals (new liquidity, price changes, asset
//      ineligibility) to simulate a live marketplace.
//   2. Advance all active executions through their state machine.
//   3. Expire stale reservations.
//
// Started once via src/instrumentation.ts (Next.js server startup hook) and
// guarded by a global singleton so hot-reload doesn't spawn duplicates.

import { db } from "@/lib/db";
import { advanceExecution } from "./execution";
import { appendAuditEvent } from "./audit";
import { findRoutes } from "./routing";
import { EXECUTION_STATUS, TERMINAL_STATES } from "./types";

const TICK_INTERVAL_MS = 1500;
const MAX_TICK_DURATION_MS = 5000;

declare global {
  var __drampEngineTicker: { interval: NodeJS.Timeout; running: boolean } | undefined;
}

let tickerStarted = false;

export function startEngineTicker() {
  if (tickerStarted) return;
  if (globalThis.__drampEngineTicker) return;
  tickerStarted = true;

  const state = { running: false };
  const interval = setInterval(async () => {
    if (state.running) return; // avoid overlapping ticks
    state.running = true;
    try {
      await tickWithTimeout();
    } catch (err) {
      console.error("[dRamp engine] tick error:", err);
    } finally {
      state.running = false;
    }
  }, TICK_INTERVAL_MS);

  globalThis.__drampEngineTicker = { interval, running: false };
  console.log("[dRamp engine] ticker started");
}

async function tickWithTimeout() {
  await Promise.race([
    runTick(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("tick timeout")), MAX_TICK_DURATION_MS),
    ),
  ]);
}

async function runTick() {
  // 1. Fire due market signals.
  await fireDueMarketSignals();

  // 2. Advance all active executions.
  const active = await db.execution.findMany({
    where: { status: { notIn: [...TERMINAL_STATES] } },
    select: { id: true },
  });
  for (const e of active) {
    try {
      await advanceExecution(e.id);
    } catch (err) {
      console.error(`[dRamp engine] advance error for ${e.id}:`, err);
    }
  }
}

// ---- Market signal firing ------------------------------------------------

async function fireDueMarketSignals() {
  const now = new Date();
  const due = await db.marketSignal.findMany({
    where: { fired: false, triggerAt: { lte: now } },
    take: 10,
  });
  for (const sig of due) {
    try {
      await applyMarketSignal(sig);
      await db.marketSignal.update({ where: { id: sig.id }, data: { fired: true } });
    } catch (err) {
      console.error(`[dRamp engine] signal ${sig.id} failed:`, err);
      await db.marketSignal.update({ where: { id: sig.id }, data: { fired: true } });
    }
  }
}

async function applyMarketSignal(sig: { id: string; kind: string; payloadJson: string }) {
  const payload = JSON.parse(sig.payloadJson);
  switch (sig.kind) {
    case "NEW_LIQUIDITY": {
      // Create a new (better) offer from an existing provider.
      const offer = await db.liquidityOffer.create({
        data: {
          providerId: payload.providerId,
          capability: payload.capability,
          sourceAsset: payload.sourceAsset,
          destinationAsset: payload.destinationAsset,
          sourceCountry: payload.sourceCountry,
          destinationCountry: payload.destinationCountry,
          rate: payload.rate,
          feeBps: payload.feeBps,
          minimumAmount: payload.minimumAmount ?? 10,
          maximumAmount: payload.maximumAmount ?? 100000,
          availableCapacity: payload.availableCapacity ?? 50000,
          settlementAssetId: payload.settlementAssetId ?? null,
          channelType: payload.channelType ?? "AUTOMATIC",
          expectedExecutionSeconds: payload.expectedExecutionSeconds ?? 30,
          incentiveBps: payload.incentiveBps ?? 0,
          active: true,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      await appendAuditEvent({
        eventType: "market_new_liquidity",
        payload: { offerId: offer.id, providerId: payload.providerId, rate: payload.rate, feeBps: payload.feeBps },
      });
      break;
    }
    case "PRICE_CHANGE": {
      if (payload.offerId) {
        await db.liquidityOffer.update({
          where: { id: payload.offerId },
          data: { rate: payload.rate, feeBps: payload.feeBps ?? undefined },
        });
      }
      await appendAuditEvent({
        eventType: "market_price_change",
        payload: { offerId: payload.offerId, rate: payload.rate },
      });
      break;
    }
    case "CAPACITY_CHANGE": {
      if (payload.offerId) {
        await db.liquidityOffer.update({
          where: { id: payload.offerId },
          data: { availableCapacity: payload.availableCapacity },
        });
      }
      await appendAuditEvent({
        eventType: "market_capacity_change",
        payload: { offerId: payload.offerId, capacity: payload.availableCapacity },
      });
      break;
    }
    case "PROVIDER_LEAVE": {
      if (payload.providerId) {
        await db.liquidityProvider.update({
          where: { id: payload.providerId },
          data: { status: "SUSPENDED" },
        });
      }
      await appendAuditEvent({
        eventType: "market_provider_leave",
        payload: { providerId: payload.providerId },
      });
      break;
    }
    case "ASSET_INELIGIBLE": {
      if (payload.assetId) {
        await db.settlementAsset.update({
          where: { id: payload.assetId },
          data: { status: "INELIGIBLE" },
        });
      }
      await appendAuditEvent({
        eventType: "market_asset_ineligible",
        payload: { assetId: payload.assetId },
      });
      break;
    }
    default:
      break;
  }
}

// Manual tick endpoint (for testing / forcing advancement).
export async function manualTick(): Promise<{ advanced: number; signals: number }> {
  await fireDueMarketSignals();
  const active = await db.execution.findMany({
    where: { status: { notIn: [...TERMINAL_STATES] } },
    select: { id: true },
  });
  let advanced = 0;
  for (const e of active) {
    try {
      const r = await advanceExecution(e.id);
      if (r.advanced) advanced++;
    } catch (err) {
      console.error(`[dRamp engine] manual advance error for ${e.id}:`, err);
    }
  }
  return { advanced, signals: 0 };
}

export function isTickerRunning(): boolean {
  return !!globalThis.__drampEngineTicker;
}

// Schedule a "better liquidity appears" signal for a waiting execution.
// This makes the golden demo deterministic: ~15s after intent creation, a
// cheaper offer appears and the router re-scores and selects it.
//
// The signal finds the current BEST route's source leg and creates a better
// competing offer (lower fee) from a COLLATERALIZED provider for that exact
// corridor. This guarantees:
//   - the improved route beats the reference (lower effective cost)
//   - the improved route uses a collateralized provider (exercises collateral
//     locking during reservation)
//   - the route remains fully automatic (demo flows without manual intervention)
export async function scheduleBetterLiquidity(intent: {
  id: string;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  sourceAmount: { toString(): string };
}, delaySeconds = 15) {
  // Find the current best route to identify which source-leg corridor to improve.
  const candidates = await findRoutes({
    sourceAmount: intent.sourceAmount,
    sourceAsset: intent.sourceAsset,
    sourceCountry: intent.sourceCountry,
    destinationAsset: intent.destinationAsset,
    destinationCountry: intent.destinationCountry,
    riskTolerance: "BALANCED",
    allowedSettlementAssets: [],
    prohibitedSettlementAssets: [],
  });
  const best = candidates.find((c) => c.tag === "BEST" && !c.hardFilterRejection) ?? candidates.find((c) => !c.hardFilterRejection);
  if (!best) return;

  // The source leg of the best route — this is the corridor we'll improve.
  const sourceLeg = best.legs.find((l) => l.role === "SOURCE") ?? best.legs[0];
  if (!sourceLeg) return;

  // Find a collateralized provider to issue the competing (better) offer.
  const candidate = await db.liquidityProvider.findFirst({
    where: { trustModel: "COLLATERALIZED", status: "ACTIVE" },
  });
  if (!candidate) return;

  const betterFee = Math.max(5, sourceLeg.feeBps - 12);
  const betterRate = Number(sourceLeg.rate.toString()) * 1.001;

  await db.marketSignal.create({
    data: {
      kind: "NEW_LIQUIDITY",
      payloadJson: JSON.stringify({
        providerId: candidate.id,
        capability: "FIAT_IN",
        sourceAsset: sourceLeg.sourceAsset,
        sourceCountry: sourceLeg.sourceCountry,
        destinationAsset: sourceLeg.destinationAsset,
        destinationCountry: sourceLeg.destinationCountry,
        rate: betterRate,
        feeBps: betterFee,
        availableCapacity: 60000,
        settlementAssetId: sourceLeg.settlementAssetId,
        channelType: "AUTOMATIC",
        expectedExecutionSeconds: 25,
        incentiveBps: 0,
        minimumAmount: 10,
        maximumAmount: 100000,
      }),
      triggerAt: new Date(Date.now() + delaySeconds * 1000),
    },
  });
}
