// Dispute + reconciliation services.
// ARCHITECTURE RULE: all economic effects (slash, compensation, adjustments)
// flow through the existing LedgerEntry + AuditEvent infrastructure.
//
// SLASHING (Prompt 2.1): the actual collateral deduction equals the approved
// `slashedAmount` — never implicitly slashes an entire execution's locked
// collateral. Rejects amounts above eligible locked collateral.

import { db } from "@/lib/db";
import { Decimal } from "@/lib/engine/money";
import { appendAuditEvent } from "@/lib/engine/audit";
import { slashCollateralAmount, SlashExceedsEligibleError } from "@/lib/engine/collateral";

// ---- Disputes ------------------------------------------------------------

export async function openDispute(input: {
  executionId: string;
  obligationId?: string;
  providerId: string;
  reason: string;
  description?: string;
  openedById: string;
}): Promise<{ id: string }> {
  const d = await db.dispute.create({
    data: {
      executionId: input.executionId,
      obligationId: input.obligationId ?? null,
      providerId: input.providerId,
      reason: input.reason,
      description: input.description ?? null,
      status: "OPEN",
      openedById: input.openedById,
    },
  });
  if (input.obligationId) {
    await db.obligation.update({ where: { id: input.obligationId }, data: { status: "DISPUTED" } });
  }
  await appendAuditEvent({
    executionId: input.executionId,
    eventType: "dispute_created",
    payload: { disputeId: d.id, providerId: input.providerId, reason: input.reason },
    actorType: "USER",
    actorId: input.openedById,
  });
  return { id: d.id };
}

export async function resolveDispute(input: {
  disputeId: string;
  resolution: string; // RESOLVED_PROVIDER | RESOLVED_USER | PARTIAL_COMPENSATION | SLASHED | CLOSED
  resolvedById: string;
  compensationAmount?: Decimal | string | number;
  slashedAmount?: Decimal | string | number;
  note?: string;
}): Promise<{ slashed: boolean; slashedAmount?: string; error?: string }> {
  const d = await db.dispute.findUnique({ where: { id: input.disputeId } });
  if (!d) throw new Error("dispute not found");

  // Prevent double-resolution.
  if (d.status !== "OPEN" && d.status !== "INVESTIGATING") {
    return { slashed: false, error: `dispute already resolved (status=${d.status})` };
  }

  // For SLASHED resolution, validate + execute the slash BEFORE updating the
  // dispute status. If the slash fails, the dispute stays OPEN.
  if (input.resolution === "SLASHED") {
    const slashAmount = new Decimal(input.slashedAmount ?? 0);
    if (slashAmount.lte(0)) {
      return { slashed: false, error: "slash amount must be positive" };
    }

    // Determine the collateral asset from the execution's locked collateral.
    const locks = await db.collateralLock.findMany({
      where: { executionId: d.executionId, providerId: d.providerId, status: "LOCKED" },
      select: { asset: true, amount: true },
    });
    if (locks.length === 0) {
      return { slashed: false, error: "no eligible locked collateral for this provider + execution" };
    }
    const collateralAsset = locks[0].asset;

    try {
      const result = await db.$transaction(async (tx) => {
        return slashCollateralAmount(
          d.executionId,
          slashAmount,
          collateralAsset,
          `dispute:${d.id}:compensation`,
          tx,
        );
      }, { timeout: 30000, maxWait: 15000 });

      // Slash succeeded — now update the dispute status.
      await db.dispute.update({
        where: { id: input.disputeId },
        data: {
          status: input.resolution,
          resolution: input.note ?? input.resolution,
          compensationAmount: input.compensationAmount ? new Decimal(input.compensationAmount) : null,
          slashedAmount: result.slashedAmount,
          resolvedById: input.resolvedById,
          resolvedAt: new Date(),
        },
      });

      // Update obligation status.
      if (d.obligationId) {
        await db.obligation.update({ where: { id: d.obligationId }, data: { status: "SLASHED" } });
      }
      // Update provider reputation.
      const provider = await db.liquidityProvider.findUnique({ where: { id: d.providerId }, select: { reputationScore: true } });
      if (provider) {
        await db.liquidityProvider.update({
          where: { id: d.providerId },
          data: { reputationScore: Math.max(0, provider.reputationScore - 0.1) },
        });
      }

      await appendAuditEvent({
        executionId: d.executionId,
        eventType: "dispute_resolved",
        payload: {
          disputeId: d.id,
          resolution: input.resolution,
          slashedAmount: result.slashedAmount.toString(),
          totalEligibleLocked: result.totalEligibleLocked.toString(),
          asset: collateralAsset,
        },
        actorType: "USER",
        actorId: input.resolvedById,
      });

      return { slashed: true, slashedAmount: result.slashedAmount.toString() };
    } catch (e) {
      // Slash failed — dispute stays OPEN, no status update.
      if (e instanceof SlashExceedsEligibleError) {
        return { slashed: false, error: e.message };
      }
      throw e;
    }
  }

  // Non-slash resolution — update status directly.
  await db.dispute.update({
    where: { id: input.disputeId },
    data: {
      status: input.resolution,
      resolution: input.note ?? input.resolution,
      compensationAmount: input.compensationAmount ? new Decimal(input.compensationAmount) : null,
      slashedAmount: input.slashedAmount ? new Decimal(input.slashedAmount) : null,
      resolvedById: input.resolvedById,
      resolvedAt: new Date(),
    },
  });

  await appendAuditEvent({
    executionId: d.executionId,
    eventType: "dispute_resolved",
    payload: { disputeId: d.id, resolution: input.resolution, compensation: input.compensationAmount?.toString() },
    actorType: "USER",
    actorId: input.resolvedById,
  });
  return { slashed: false };
}

// ---- Reconciliation ------------------------------------------------------

export async function detectReconciliationItems(providerId: string): Promise<any[]> {
  const stale = await db.obligation.findMany({
    where: {
      providerId,
      status: { in: ["CREATED", "ACTIVE"] },
      dueAt: { lt: new Date() },
    },
    include: { execution: true },
  });
  const items: any[] = [];
  for (const o of stale) {
    items.push({
      providerId,
      type: "STALE_OBLIGATION",
      severity: "HIGH",
      executionId: o.executionId,
      obligationId: o.id,
      expectedAmount: o.amount.toString(),
      asset: o.asset,
      description: `Obligation past due (${new Date(o.dueAt).toISOString()}) — no settlement confirmation received.`,
    });
  }
  return items;
}

export async function createReconciliationItem(input: {
  providerId: string;
  type: string;
  severity?: string;
  executionId?: string;
  obligationId?: string;
  expectedAmount?: string;
  reportedAmount?: string;
  asset?: string;
  description?: string;
}): Promise<{ id: string }> {
  const item = await db.reconciliationItem.create({
    data: {
      providerId: input.providerId,
      type: input.type,
      severity: input.severity ?? "MEDIUM",
      executionId: input.executionId ?? null,
      obligationId: input.obligationId ?? null,
      expectedAmount: input.expectedAmount ? new Decimal(input.expectedAmount) : null,
      reportedAmount: input.reportedAmount ? new Decimal(input.reportedAmount) : null,
      asset: input.asset ?? null,
      description: input.description ?? null,
      status: "DETECTED",
    },
  });
  await appendAuditEvent({
    eventType: "reconciliation_item_created",
    payload: { itemId: item.id, providerId: input.providerId, type: input.type },
    actorType: "SYSTEM",
  });
  return { id: item.id };
}

export async function resolveReconciliationItem(input: {
  itemId: string;
  status: string; // MATCHED | ADJUSTED | RESOLVED
  resolution: string;
  resolvedById: string;
}): Promise<void> {
  await db.reconciliationItem.update({
    where: { id: input.itemId },
    data: { status: input.status, resolution: input.resolution, resolvedById: input.resolvedById, resolvedAt: new Date() },
  });
  const item = await db.reconciliationItem.findUnique({ where: { id: input.itemId } });
  await appendAuditEvent({
    eventType: "reconciliation_resolved",
    payload: { itemId: input.itemId, status: input.status, resolution: input.resolution, providerId: item?.providerId },
    actorType: "USER",
    actorId: input.resolvedById,
  });
}
