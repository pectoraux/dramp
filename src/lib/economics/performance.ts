// ProviderPerformanceService — tracks execution metrics per provider and
// per corridor. Records outcomes on execution completion/failure/cancellation.
//
// ARCHITECTURE RULE: this extends the existing execution state machine, not
// replaces it. It's called as a hook from completeExecution / cancelExecution
// / expireExecution to record observable outcomes. The metrics feed the
// ReputationService and the routing engine.

import { db } from "@/lib/db";
import { Decimal, moneyAdd } from "@/lib/engine/money";
import { appendAuditEvent } from "@/lib/engine/audit";

// Record a provider's execution outcome (called on completion/failure/cancel).
export async function recordExecutionOutcome(
  executionId: string,
  providerId: string,
  outcome: "COMPLETED" | "FAILED" | "CANCELLED",
  leg?: { sourceAsset: string; destinationAsset: string; sourceCountry: string; destinationCountry: string; amount: Decimal; offer?: { feeBps: number } | null },
): Promise<void> {
  try {
    const execution = await db.execution.findUnique({
      where: { id: executionId },
      select: { startedAt: true, completedAt: true, intent: { select: { sourceAsset: true, destinationAsset: true, sourceCountry: true, destinationCountry: true } } },
    });
    if (!execution) return;

    const durationSec = execution.completedAt
      ? Math.round((execution.completedAt.getTime() - execution.startedAt.getTime()) / 1000)
      : 0;

    // Update corridor score if we have leg info.
    if (leg) {
      await updateCorridorScore(providerId, leg, outcome, durationSec);
    }

    // Update tier if needed (lazy — recompute on next reputation query).
    // We don't force a tier update here to avoid DB contention.
  } catch (err) {
    console.error(`[dRamp economics] outcome recording error for ${executionId}:`, err);
  }
}

// Update the per-provider-per-corridor score.
async function updateCorridorScore(
  providerId: string,
  leg: { sourceAsset: string; destinationAsset: string; sourceCountry: string; destinationCountry: string; amount: Decimal; offer?: { feeBps: number } | null },
  outcome: "COMPLETED" | "FAILED" | "CANCELLED",
  durationSec: number,
): Promise<void> {
  const key = {
    providerId,
    sourceAsset: leg.sourceAsset,
    destinationAsset: leg.destinationAsset,
    sourceCountry: leg.sourceCountry,
    destinationCountry: leg.destinationCountry,
  };

  const existing = await db.providerCorridorScore.findUnique({ where: { providerId_sourceAsset_destinationAsset_sourceCountry_destinationCountry: key } });

  const executions = (existing?.executions ?? 0) + 1;
  const completed = (existing?.completed ?? 0) + (outcome === "COMPLETED" ? 1 : 0);
  const failed = (existing?.failed ?? 0) + (outcome === "FAILED" ? 1 : 0);
  const completionRate = executions > 0 ? completed / executions : 0;
  const totalVolume = moneyAdd(existing?.totalVolume ?? new Decimal(0), leg.amount);
  const prevAvgDur = existing?.avgExecutionSeconds ?? 0;
  const prevExecs = existing?.executions ?? 0;
  const newAvgDur = prevExecs > 0 ? Math.round((prevAvgDur * prevExecs + durationSec) / executions) : durationSec;
  const feeBps = leg.offer?.feeBps ?? 0;
  const prevAvgFee = existing?.avgFeeBps ?? 0;
  const newAvgFee = prevExecs > 0 ? (prevAvgFee * prevExecs + feeBps) / executions : feeBps;

  // Score: weighted completion rate + speed factor.
  const speedFactor = Math.max(0, 1 - durationSec / 600);
  const newScore = completionRate * 0.7 + speedFactor * 0.3;

  await db.providerCorridorScore.upsert({
    where: { providerId_sourceAsset_destinationAsset_sourceCountry_destinationCountry: key },
    update: {
      executions,
      completed,
      failed,
      completionRate,
      totalVolume,
      avgExecutionSeconds: newAvgDur,
      avgFeeBps: newAvgFee,
      lastExecutedAt: new Date(),
      score: newScore,
    },
    create: {
      ...key,
      executions,
      completed,
      failed,
      completionRate,
      totalVolume,
      avgExecutionSeconds: newAvgDur,
      avgFeeBps: newAvgFee,
      lastExecutedAt: new Date(),
      score: newScore,
    },
  });
}

// Record a performance snapshot (called periodically or on-demand).
export async function recordPerformanceSnapshot(providerId: string, periodDays = 30): Promise<void> {
  const now = new Date();
  const periodStart = new Date(now.getTime() - periodDays * 86400000);

  const legs = await db.leg.findMany({
    where: { providerId, execution: { startedAt: { gte: periodStart } } },
    include: { execution: true, offer: true },
  });

  const { getProviderReputation } = await import("./reputation");
  const rep = await getProviderReputation(providerId);

  const totalVolume = legs.reduce((s, l) => s.plus(new Decimal(l.amount)), new Decimal(0));
  const completed = legs.filter((l) => l.execution?.status === "COMPLETED").length;
  const failed = legs.filter((l) => l.execution?.status === "FAILED" || l.status === "FAILED").length;
  const cancelled = legs.filter((l) => l.execution?.status === "CANCELLED").length;
  const durations = legs
    .filter((l) => l.execution?.completedAt)
    .map((l) => (l.execution!.completedAt!.getTime() - l.execution!.startedAt.getTime()) / 1000);
  const avgDur = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0;

  await db.providerPerformanceSnapshot.create({
    data: {
      providerId,
      periodStart,
      periodEnd: now,
      executionsAccepted: legs.length,
      executionsCompleted: completed,
      executionsFailed: failed,
      executionsCancelled: cancelled,
      totalVolume,
      avgExecutionSeconds: avgDur,
      reliabilityScore: rep.components.reliability / 100,
      speedScore: rep.components.speed / 100,
      liquidityScore: rep.components.liquidityQuality / 100,
      pricingScore: rep.components.pricing / 100,
      disputeScore: rep.components.disputes / 100,
      operationalScore: rep.components.operational / 100,
      overallReputation: rep.components.overall / 100,
    },
  });
}

// Get a provider's performance summary (current metrics, not historical).
export async function getProviderPerformance(providerId: string) {
  const legs = await db.leg.findMany({
    where: { providerId },
    include: { execution: { include: { intent: true } }, offer: true },
    orderBy: { execution: { startedAt: "desc" } },
    take: 200,
  });

  const total = legs.length;
  const completed = legs.filter((l) => l.execution?.status === "COMPLETED").length;
  const failed = legs.filter((l) => l.execution?.status === "FAILED" || l.status === "FAILED").length;
  const cancelled = legs.filter((l) => l.execution?.status === "CANCELLED").length;
  const completionRate = total > 0 ? completed / total : 0;
  const durations = legs
    .filter((l) => l.execution?.completedAt)
    .map((l) => (l.execution!.completedAt!.getTime() - l.execution!.startedAt.getTime()) / 1000);
  const avgExecutionTime = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0;
  const totalVolume = legs.reduce((s, l) => s + Number(l.amount.toString()), 0);

  // Earnings from ledger entries credited to this provider.
  const ledgerEntries = await db.ledgerEntry.findMany({
    where: { creditAccount: { startsWith: `provider:${providerId}:` }, entryType: { in: ["FEE", "INCENTIVE"] } },
    select: { amount: true, entryType: true, asset: true },
  });
  const feeEarnings = ledgerEntries.filter((e) => e.entryType === "FEE").reduce((s, e) => s + Number(e.amount.toString()), 0);
  const incentiveEarnings = ledgerEntries.filter((e) => e.entryType === "INCENTIVE").reduce((s, e) => s + Number(e.amount.toString()), 0);

  // Corridor scores.
  const corridorScores = await db.providerCorridorScore.findMany({
    where: { providerId },
    orderBy: { executions: "desc" },
  });

  // Liquidity metrics.
  const offers = await db.liquidityOffer.findMany({
    where: { providerId, active: true },
    select: { availableCapacity: true, reservedCapacity: true },
  });
  const availableLiquidity = offers.reduce((s, o) => s + Number(o.availableCapacity.toString()), 0);
  const reservedLiquidity = offers.reduce((s, o) => s + Number(o.reservedCapacity.toString()), 0);
  const utilization = availableLiquidity > 0 ? reservedLiquidity / availableLiquidity : 0;

  return {
    totalExecutions: total,
    completed,
    failed,
    cancelled,
    completionRate: Math.round(completionRate * 100) / 100,
    avgExecutionSeconds: avgExecutionTime,
    totalVolume,
    feeEarnings,
    incentiveEarnings,
    totalEarnings: feeEarnings + incentiveEarnings,
    availableLiquidity,
    reservedLiquidity,
    utilization: Math.round(utilization * 100) / 100,
    corridors: corridorScores.map((c) => ({
      corridor: `${c.sourceAsset}:${c.sourceCountry} → ${c.destinationAsset}:${c.destinationCountry}`,
      executions: c.executions,
      completed: c.completed,
      failed: c.failed,
      completionRate: Math.round(c.completionRate * 100) / 100,
      avgExecutionSeconds: c.avgExecutionSeconds,
      score: Math.round(c.score * 100) / 100,
      lastExecutedAt: c.lastExecutedAt,
    })),
  };
}
