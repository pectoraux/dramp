// Provider adapters — a common interface so the router treats all liquidity
// sources interchangeably. Mock implementations simulate automatic
// confirmations and manual rails for the prototype.

import { db } from "@/lib/db";
import { Decimal } from "../money";
import {
  CHANNEL_TYPE,
  PROVIDER_TYPE,
} from "../types";
import { appendAuditEvent } from "../audit";

export interface AcceptResult {
  accepted: boolean;
  reason?: string;
  automatic: boolean;
}

export interface ConfirmResult {
  confirmed: boolean;
  reference?: string;
  reason?: string;
}

export interface LiquidityProviderAdapter {
  providerType: string;
  // Accept or reject an execution leg assigned to this provider.
  acceptExecution(leg: { id: string; providerId: string; channelType: string; amount: Decimal; sourceAsset: string; destinationAsset: string }): AcceptResult;
  // Confirm a settlement/payout step. For automatic providers this is
  // machine-generated; for manual providers it returns pending until a human
  // confirms via the provider console.
  confirmSettlement(leg: { id: string; providerId: string; channelType: string }): ConfirmResult;
  // Report a failure (used by failure tests / dispute path).
  reportFailure(leg: { id: string; providerId: string }, reason: string): void;
}

// ---- Automatic adapters (PSP, Bank, CEX, DEX, Stablecoin LP, Treasury) ----

function makeAutomaticAdapter(providerType: string, baseFailureRate = 0): LiquidityProviderAdapter {
  return {
    providerType,
    acceptExecution(leg) {
      return { accepted: true, automatic: leg.channelType === CHANNEL_TYPE.AUTOMATIC };
    },
    confirmSettlement(leg) {
      // Automatic rails confirm instantly with a generated reference.
      if (leg.channelType !== CHANNEL_TYPE.AUTOMATIC) {
        return { confirmed: false, reason: "Manual confirmation required" };
      }
      if (baseFailureRate > 0 && Math.random() < baseFailureRate) {
        return { confirmed: false, reason: "Simulated automatic rail failure" };
      }
      return {
        confirmed: true,
        reference: `${providerType.slice(0, 3)}-${leg.id.slice(-8).toUpperCase()}`,
      };
    },
    reportFailure() {},
  };
}

// ---- Local fiat agent (may be automatic or manual) -----------------------

function makeLocalFiatAgentAdapter(): LiquidityProviderAdapter {
  return {
    providerType: PROVIDER_TYPE.LOCAL_FIAT_AGENT,
    acceptExecution(leg) {
      return { accepted: true, automatic: leg.channelType === CHANNEL_TYPE.AUTOMATIC };
    },
    confirmSettlement(leg) {
      if (leg.channelType === CHANNEL_TYPE.AUTOMATIC) {
        return { confirmed: true, reference: `LFA-${leg.id.slice(-8).toUpperCase()}` };
      }
      // Manual: remains pending until the agent confirms in the console.
      return { confirmed: false, reason: "Awaiting manual confirmation by agent" };
    },
    reportFailure() {},
  };
}

// ---- Adapter registry ----------------------------------------------------

const adapters: Record<string, LiquidityProviderAdapter> = {
  [PROVIDER_TYPE.PSP]: makeAutomaticAdapter(PROVIDER_TYPE.PSP),
  [PROVIDER_TYPE.BANK]: makeAutomaticAdapter(PROVIDER_TYPE.BANK),
  [PROVIDER_TYPE.CEX]: makeAutomaticAdapter(PROVIDER_TYPE.CEX),
  [PROVIDER_TYPE.DEX]: makeAutomaticAdapter(PROVIDER_TYPE.DEX),
  [PROVIDER_TYPE.STABLECOIN_LP]: makeAutomaticAdapter(PROVIDER_TYPE.STABLECOIN_LP),
  [PROVIDER_TYPE.TREASURY]: makeAutomaticAdapter(PROVIDER_TYPE.TREASURY),
  [PROVIDER_TYPE.MARKET_MAKER]: makeAutomaticAdapter(PROVIDER_TYPE.MARKET_MAKER),
  [PROVIDER_TYPE.SETTLEMENT_ASSET_SPONSOR]: makeAutomaticAdapter(PROVIDER_TYPE.SETTLEMENT_ASSET_SPONSOR),
  [PROVIDER_TYPE.LOCAL_FIAT_AGENT]: makeLocalFiatAgentAdapter(),
  [PROVIDER_TYPE.HYBRID]: makeLocalFiatAgentAdapter(),
};

export function getAdapter(providerType: string): LiquidityProviderAdapter {
  return adapters[providerType] ?? makeAutomaticAdapter(providerType);
}

// Attempt an automatic confirmation for a leg. Returns true if the leg was
// auto-confirmed (or was already confirmed). For manual legs, returns false.
export async function attemptAutomaticConfirmation(legId: string): Promise<{ confirmed: boolean; reference?: string; reason?: string }> {
  const leg = await db.leg.findUnique({
    where: { id: legId },
    include: { provider: true, offer: true },
  });
  if (!leg) return { confirmed: false, reason: "Leg not found" };
  if (leg.status === "CONFIRMED") return { confirmed: true, reference: leg.actorNote ?? undefined };

  const adapter = getAdapter(leg.provider.providerType);
  const result = adapter.confirmSettlement({
    id: leg.id,
    providerId: leg.providerId,
    channelType: leg.channelType,
  });
  if (result.confirmed) {
    await db.leg.update({
      where: { id: leg.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        actorId: `adapter:${leg.provider.providerType}`,
        actorNote: result.reference ?? "automatic",
      },
    });
    await appendAuditEvent({
      executionId: leg.executionId ?? undefined,
      eventType: "leg_confirmed",
      payload: { legId: leg.id, providerId: leg.providerId, reference: result.reference, channel: leg.channelType },
      actorType: "PROVIDER",
      actorId: leg.providerId,
    });
    return { confirmed: true, reference: result.reference };
  }
  return { confirmed: false, reason: result.reason };
}

// Manual confirmation performed by a human via the provider console.
export async function manualConfirmLeg(legId: string, actorId: string, note: string): Promise<void> {
  const leg = await db.leg.findUnique({
    where: { id: legId },
    include: { provider: true },
  });
  if (!leg) throw new Error("Leg not found");
  if (leg.channelType !== CHANNEL_TYPE.MANUAL) {
    throw new Error("Leg is not a manual channel");
  }
  await db.leg.update({
    where: { id: leg.id },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      actorId,
      actorNote: note,
    },
  });
  await appendAuditEvent({
    executionId: leg.executionId ?? undefined,
    eventType: "leg_manual_confirmed",
    payload: { legId: leg.id, providerId: leg.providerId, actorId, note },
    actorType: "PROVIDER",
    actorId,
  });
}

// Report a manual failure (creates an obligation/dispute path).
export async function reportLegFailure(legId: string, reason: string): Promise<void> {
  const leg = await db.leg.findUnique({
    where: { id: legId },
    include: { provider: true },
  });
  if (!leg) throw new Error("Leg not found");
  await db.leg.update({
    where: { id: leg.id },
    data: { status: "FAILED" },
  });
  await appendAuditEvent({
    executionId: leg.executionId ?? undefined,
    eventType: "leg_failed",
    payload: { legId: leg.id, providerId: leg.providerId, reason },
    actorType: "PROVIDER",
    actorId: leg.providerId,
  });
}
