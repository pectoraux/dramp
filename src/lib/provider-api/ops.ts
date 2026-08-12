// Ops service — network operations data, all derived from existing entities.
// No parallel state; these are read-only aggregations over ExecutionIntent,
// Execution, LiquidityProvider, LiquidityOffer, Vault, Obligation, etc.

import { db } from "@/lib/db";
import { Decimal, moneyAdd } from "@/lib/engine/money";
import { providerCounterpartyRisk, providerRiskFromRecord, settlementAssetRisk, settlementAssetRiskFromRecord } from "@/lib/engine/risk";

// ---- Network overview ---------------------------------------------------
export async function getNetworkOverview() {
  const [providers, activeOffers, activeExecutions, completedExecutions, obligations, vaults, campaigns] = await Promise.all([
    db.liquidityProvider.count({ where: { status: "ACTIVE" } }),
    db.liquidityOffer.aggregate({ where: { active: true, provider: { status: "ACTIVE" } }, _sum: { availableCapacity: true, reservedCapacity: true } }),
    db.execution.count({ where: { status: { notIn: ["COMPLETED", "EXPIRED", "CANCELLED", "FAILED", "REFUNDED"] } } }),
    db.execution.findMany({ where: { status: "COMPLETED" }, include: { intent: true } }),
    db.obligation.aggregate({ where: { status: { in: ["CREATED", "ACTIVE"] } }, _sum: { amount: true } }),
    db.vault.findMany(),
    db.settlementIncentiveCampaign.aggregate({ where: { status: "ACTIVE" }, _sum: { accrued: true, paid: true, totalBudget: true } }),
  ]);

  const totalVolume = completedExecutions.reduce((s, e) => s + Number(e.intent.sourceAmount.toString()), 0);
  const aggregateExposure = vaults.reduce((s, v) => s + Number(v.lockedCollateral.toString()), 0);
  const aggregateCollateral = vaults.reduce((s, v) => s + Number(v.usableCollateral.toString()), 0);

  // Incentive accounting: accrued = cumulative earned, paid = cumulative disbursed.
  // remainingBudget = totalBudget - accrued; unpaidAccrued = accrued - paid.
  const incentiveBudget = new Decimal(campaigns._sum.totalBudget ?? 0);
  const incentiveAccrued = new Decimal(campaigns._sum.accrued ?? 0);
  const incentivePaid = new Decimal(campaigns._sum.paid ?? 0);

  return {
    totalVolume,
    completedCount: completedExecutions.length,
    activeExecutionCount: activeExecutions,
    activeProviders: providers,
    availableLiquidity: activeOffers._sum.availableCapacity?.toString() ?? "0",
    reservedLiquidity: activeOffers._sum.reservedCapacity?.toString() ?? "0",
    aggregateExposure: aggregateExposure.toString(),
    aggregateCollateral: aggregateCollateral.toString(),
    unsettledObligations: obligations._sum.amount?.toString() ?? "0",
    incentiveBudget: incentiveBudget.toString(),
    incentiveAccrued: incentiveAccrued.toString(),
    incentivePaid: incentivePaid.toString(),
    incentiveRemaining: incentiveBudget.minus(incentiveAccrued).toString(),
    incentiveUnpaidAccrued: incentiveAccrued.minus(incentivePaid).toString(),
  };
}

// ---- Execution queue (waiting intents) ----------------------------------
export async function getExecutionQueue() {
  const waiting = await db.execution.findMany({
    where: { status: "SEARCHING" },
    include: { intent: true },
    orderBy: { startedAt: "asc" },
    take: 50,
  });
  const now = Date.now();
  return waiting.map((e) => {
    const elapsed = Math.floor((now - e.startedAt.getTime()) / 1000);
    const remaining = Math.max(0, e.intent.maxWaitSeconds - elapsed);
    return {
      executionId: e.id,
      intentId: e.intentId,
      sourceAsset: e.intent.sourceAsset,
      destinationAsset: e.intent.destinationAsset,
      sourceCountry: e.intent.sourceCountry,
      destinationCountry: e.intent.destinationCountry,
      amount: e.intent.sourceAmount.toString(),
      riskTolerance: e.intent.riskTolerance,
      executionPolicy: e.intent.executionPolicy,
      elapsedSeconds: elapsed,
      remainingWaitSeconds: remaining,
      referenceRouteId: e.referenceRouteId,
    };
  });
}

// ---- Bottleneck analysis ------------------------------------------------
export async function getBottlenecks() {
  // Corridors with waiting intents but insufficient liquidity.
  const waiting = await db.executionIntent.findMany({
    where: { status: "ACTIVE", executions: { some: { status: "SEARCHING" } } },
    select: { sourceAsset: true, destinationAsset: true, sourceCountry: true, destinationCountry: true, sourceAmount: true },
  });
  const corridorDemand = new Map<string, { count: number; totalAmount: number }>();
  for (const w of waiting) {
    const key = `${w.sourceAsset}:${w.sourceCountry} → ${w.destinationAsset}:${w.destinationCountry}`;
    const cur = corridorDemand.get(key) ?? { count: 0, totalAmount: 0 };
    cur.count++;
    cur.totalAmount += Number(w.sourceAmount.toString());
    corridorDemand.set(key, cur);
  }

  // Providers near capacity (reserved/available > 70%).
  const offers = await db.liquidityOffer.findMany({ where: { active: true }, include: { provider: true } });
  const nearCapacity = offers
    .filter((o) => {
      const avail = Number(o.availableCapacity.toString());
      const res = Number(o.reservedCapacity.toString());
      return avail > 0 && res / avail > 0.7;
    })
    .map((o) => ({
      providerName: o.provider.name,
      providerType: o.provider.providerType,
      corridor: `${o.sourceAsset}:${o.sourceCountry} → ${o.destinationAsset}:${o.destinationCountry}`,
      available: o.availableCapacity.toString(),
      reserved: o.reservedCapacity.toString(),
      utilization: Math.round((Number(o.reservedCapacity.toString()) / Number(o.availableCapacity.toString())) * 100),
    }));

  // Manual-channel offers (potential bottlenecks).
  const manualOffers = offers
    .filter((o) => o.channelType === "MANUAL")
    .map((o) => ({
      providerName: o.provider.name,
      corridor: `${o.sourceAsset} → ${o.destinationAsset}`,
      expectedExecutionSeconds: o.expectedExecutionSeconds,
    }));

  return {
    corridorDemand: [...corridorDemand.entries()].map(([corridor, d]) => ({ corridor, ...d })),
    providersNearCapacity: nearCapacity,
    manualBottlenecks: manualOffers,
  };
}

// ---- Provider risk monitor ----------------------------------------------
export async function getProviderRiskMonitor() {
  const providers = await db.liquidityProvider.findMany({
    include: { vault: true, offers: { where: { active: true } }, obligations: { where: { status: { in: ["CREATED", "ACTIVE"] } } } },
  });
  return providers.map((p) => {
    const risk = providerCounterpartyRisk(providerRiskFromRecord(p));
    const exposure = p.vault ? Number(p.vault.lockedCollateral.toString()) : 0;
    const maxExposure = p.vault ? Number(p.vault.maxExposure.toString()) : 0;
    const utilization = maxExposure > 0 ? Math.round((exposure / maxExposure) * 100) : 0;
    const activeOffers = p.offers.length;
    const activeObligations = p.obligations.length;
    const flagged = utilization > 80 || risk > 0.6;
    return {
      id: p.id,
      name: p.name,
      providerType: p.providerType,
      trustModel: p.trustModel,
      reputationScore: p.reputationScore,
      status: p.status,
      counterpartyRisk: Math.round(risk * 100) / 100,
      exposure: exposure.toString(),
      maxExposure: p.vault?.maxExposure.toString() ?? "0",
      utilization,
      activeOffers,
      activeObligations,
      flagged,
    };
  });
}

// ---- Settlement asset risk monitor --------------------------------------
export async function getSettlementAssetRiskMonitor() {
  const assets = await db.settlementAsset.findMany();
  const offers = await db.liquidityOffer.findMany({ where: { active: true }, include: { provider: true } });
  return assets.map((a) => {
    const risk = settlementAssetRisk(settlementAssetRiskFromRecord(a));
    const dependentOffers = offers.filter((o) => o.settlementAssetId === a.id);
    const providerCount = new Set(dependentOffers.map((o) => o.providerId)).size;
    return {
      id: a.id,
      symbol: a.symbol,
      assetType: a.assetType,
      volatilityScore: a.volatilityScore,
      liquidityScore: a.liquidityScore,
      pegQuality: a.pegQuality,
      incentiveRate: a.incentiveRate,
      riskScore: Math.round(risk * 100) / 100,
      status: a.status,
      isEligibleCollateral: a.isEligibleCollateral,
      dependentOfferCount: dependentOffers.length,
      providerCount,
    };
  });
}

// ---- Provider concentration ---------------------------------------------
export async function getProviderConcentration() {
  const providers = await db.liquidityProvider.findMany({
    where: { status: "ACTIVE" },
    include: { offers: { where: { active: true } }, vault: true },
  });
  const byType = new Map<string, number>();
  const byCountry = new Map<string, number>();
  let totalOffers = 0;
  for (const p of providers) {
    byType.set(p.providerType, (byType.get(p.providerType) ?? 0) + p.offers.length);
    totalOffers += p.offers.length;
    const countries = JSON.parse(p.countries) as string[];
    for (const c of countries) byCountry.set(c, (byCountry.get(c) ?? 0) + p.offers.length);
  }

  // Collateral concentration by asset.
  const collateralByAsset = new Map<string, number>();
  for (const p of providers) {
    if (!p.vault) continue;
    const holdings = JSON.parse(p.vault.holdingsJson) as { asset: string; amount: string }[];
    for (const h of holdings) {
      collateralByAsset.set(h.asset, (collateralByAsset.get(h.asset) ?? 0) + Number(h.amount));
    }
  }

  return {
    offersByProviderType: [...byType.entries()].map(([type, count]) => ({ type, count, share: totalOffers > 0 ? Math.round((count / totalOffers) * 100) : 0 })),
    offersByCountry: [...byCountry.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    collateralByAsset: [...collateralByAsset.entries()].map(([asset, amount]) => ({ asset, amount: amount.toString() })),
    totalActiveProviders: providers.length,
    totalActiveOffers: totalOffers,
  };
}
