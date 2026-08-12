// ProviderEconomicsService — earnings, capital efficiency, statements.
//
// ARCHITECTURE RULE: all earnings data is derived from the existing ledger.
// No shadow balances. The provider statement reconciles against ledger entries.

import { db } from "@/lib/db";
import { Decimal } from "@/lib/engine/money";

// Get a provider's economic summary (earnings from ledger entries).
export async function getProviderEconomics(providerId: string): Promise<any> {
  // Fetch all ledger entries that credit or debit the provider's accounts.
  const entries = await db.ledgerEntry.findMany({
    where: {
      OR: [
        { creditAccount: { startsWith: `provider:${providerId}:` } },
        { debitAccount: { startsWith: `provider:${providerId}:` } },
      ],
    },
    select: { debitAccount: true, creditAccount: true, amount: true, asset: true, entryType: true, executionId: true, timestamp: true },
    orderBy: { timestamp: "desc" },
  });

  // Categorize earnings.
  let executionFees = 0;
  let incentives = 0;
  let rebates = 0;
  let penalties = 0;
  let slashing = 0;
  let compensation = 0;

  for (const e of entries) {
    const amount = Number(e.amount.toString());
    const isCredit = e.creditAccount.startsWith(`provider:${providerId}:`);
    const signedAmount = isCredit ? amount : -amount;

    switch (e.entryType) {
      case "FEE": executionFees += signedAmount; break;
      case "INCENTIVE": incentives += signedAmount; break;
      case "COMPENSATION": compensation += signedAmount; break;
      case "SLASH": slashing += signedAmount; break;
      case "REFUND": penalties += signedAmount; break;
    }
  }

  // Capital metrics.
  const offers = await db.liquidityOffer.findMany({
    where: { providerId },
    select: { availableCapacity: true, reservedCapacity: true, active: true },
  });
  const committedCapital = offers.reduce((s, o) => s + Number(o.availableCapacity.toString()), 0);
  const reservedCapital = offers.reduce((s, o) => s + Number(o.reservedCapacity.toString()), 0);
  const deployedCapital = reservedCapital;
  const idleCapital = committedCapital - reservedCapital;

  // Vault metrics (if collateralized).
  const vault = await db.vault.findUnique({
    where: { providerId },
    select: { usableCollateral: true, lockedCollateral: true, maxExposure: true },
  });

  // Execution metrics.
  const legs = await db.leg.findMany({
    where: { providerId },
    include: { execution: { select: { status: true, startedAt: true, completedAt: true } } },
  });
  const totalExecutions = legs.length;
  const completed = legs.filter((l) => l.execution?.status === "COMPLETED").length;

  // Capital efficiency: earnings per unit of deployed capital.
  // netEarnings = gross earnings (fees + incentives + rebates)
  //               - gross costs (penalties + slashing)
  // compensation and refunds are categorized separately (they are not
  // deductions from earnings — they are separate economic events).
  const grossEarnings = executionFees + incentives + rebates;
  const grossCosts = penalties + slashing;
  const netEarnings = grossEarnings - grossCosts;
  const earningsPerLiquidity = committedCapital > 0 ? netEarnings / committedCapital : 0;
  const capitalTurnover = committedCapital > 0
    ? legs.reduce((s, l) => s + Number(l.amount.toString()), 0) / committedCapital
    : 0;

  return {
    earnings: {
      executionFees: executionFees.toFixed(2),
      incentives: incentives.toFixed(2),
      rebates: rebates.toFixed(2),
      penalties: penalties.toFixed(2),
      slashing: slashing.toFixed(2),
      compensation: compensation.toFixed(2),
      grossEarnings: grossEarnings.toFixed(2),
      grossCosts: grossCosts.toFixed(2),
      netEarnings: netEarnings.toFixed(2),
    },
    capital: {
      committed: committedCapital.toFixed(2),
      deployed: deployedCapital.toFixed(2),
      reserved: reservedCapital.toFixed(2),
      idle: idleCapital.toFixed(2),
      vaultUsable: vault?.usableCollateral.toString() ?? "0",
      vaultLocked: vault?.lockedCollateral.toString() ?? "0",
      maxExposure: vault?.maxExposure.toString() ?? "0",
    },
    performance: {
      totalExecutions,
      completed,
      completionRate: totalExecutions > 0 ? Math.round((completed / totalExecutions) * 100) / 100 : 0,
    },
    efficiency: {
      earningsPerLiquidity: earningsPerLiquidity.toFixed(6),
      capitalTurnover: Math.round(capitalTurnover * 100) / 100,
      netEarnings: netEarnings.toFixed(2),
      note: "Prototype analytics — based on simulated valuations.",
    },
  };
}

// Get a provider statement for a date range (reconciles against ledger).
export async function getProviderStatement(providerId: string, startDate: Date, endDate: Date): Promise<any> {
  const entries = await db.ledgerEntry.findMany({
    where: {
      timestamp: { gte: startDate, lte: endDate },
      OR: [
        { creditAccount: { startsWith: `provider:${providerId}:` } },
        { debitAccount: { startsWith: `provider:${providerId}:` } },
      ],
    },
    orderBy: { timestamp: "asc" },
  });

  const categorized = entries.map((e) => {
    const amount = Number(e.amount.toString());
    const isCredit = e.creditAccount.startsWith(`provider:${providerId}:`);
    return {
      timestamp: e.timestamp,
      type: e.entryType,
      asset: e.asset,
      amount: amount.toFixed(6),
      signedAmount: (isCredit ? amount : -amount).toFixed(6),
      direction: isCredit ? "credit" : "debit",
      executionId: e.executionId,
      description: e.description,
    };
  });

  const totals = categorized.reduce((acc, e) => {
    const signed = Number(e.signedAmount);
    switch (e.type) {
      case "FEE": acc.executionFees += signed; break;
      case "INCENTIVE": acc.incentives += signed; break;
      case "SLASH": acc.slashing += signed; break;
      case "COMPENSATION": acc.compensation += signed; break;
      case "REFUND": acc.refunds += signed; break;
    }
    acc.net += signed;
    return acc;
  }, { executionFees: 0, incentives: 0, slashing: 0, compensation: 0, refunds: 0, net: 0 });

  return {
    providerId,
    period: { start: startDate, end: endDate },
    entries: categorized,
    summary: {
      executionFees: totals.executionFees.toFixed(2),
      incentives: totals.incentives.toFixed(2),
      slashing: totals.slashing.toFixed(2),
      compensation: totals.compensation.toFixed(2),
      refunds: totals.refunds.toFixed(2),
      netChange: totals.net.toFixed(2),
      entryCount: categorized.length,
    },
  };
}
