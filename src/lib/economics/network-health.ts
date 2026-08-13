// NetworkHealthService — transparent marketplace health score.
//
// ARCHITECTURE RULE: built from observable components, not an opaque AI score.

import { db } from "@/lib/db";

export interface NetworkHealth {
  liquidityDepth: number;      // 0..100
  routeCompetition: number;    // 0..100
  providerReliability: number; // 0..100
  executionSuccess: number;    // 0..100
  averageWait: number;         // seconds
  riskConcentration: number;   // 0..100 (lower = more concentrated)
  overall: number;             // 0..100
  components: Record<string, number>;
}

export async function getNetworkHealth(): Promise<NetworkHealth> {
  // Liquidity depth: total available capacity.
  const offers = await db.liquidityOffer.aggregate({
    where: { active: true, provider: { status: "ACTIVE" } },
    _sum: { availableCapacity: true },
  });
  const totalLiquidity = Number(offers._sum.availableCapacity ?? 0);
  const liquidityDepth = Math.min(100, totalLiquidity / 10000); // 1M → 100

  // Route competition: average number of active offers per corridor.
  const corridors = await db.liquidityOffer.groupBy({
    by: ["sourceAsset", "destinationAsset"],
    where: { active: true, provider: { status: "ACTIVE" } },
    _count: true,
  });
  const avgOffersPerCorridor = corridors.length > 0
    ? corridors.reduce((s, c) => s + c._count, 0) / corridors.length
    : 0;
  const routeCompetition = Math.min(100, (avgOffersPerCorridor / 5) * 100); // 5 offers → 100

  // Provider reliability: average reputation score.
  const providers = await db.liquidityProvider.findMany({
    where: { status: "ACTIVE" },
    select: { reputationScore: true },
  });
  const providerReliability = providers.length > 0
    ? (providers.reduce((s, p) => s + p.reputationScore, 0) / providers.length) * 100
    : 50;

  // Execution success: completion rate.
  const execs = await db.execution.groupBy({
    by: ["status"],
    _count: true,
  });
  const totalExecs = execs.reduce((s, e) => s + e._count, 0);
  const completedExecs = execs.find((e) => e.status === "COMPLETED")?._count ?? 0;
  const executionSuccess = totalExecs > 0 ? (completedExecs / totalExecs) * 100 : 50;

  // Average wait: average waitedSeconds for completed executions.
  const recentExecs = await db.execution.findMany({
    where: { status: "COMPLETED" },
    select: { waitedSeconds: true },
    take: 50,
    orderBy: { completedAt: "desc" },
  });
  const averageWait = recentExecs.length > 0
    ? Math.round(recentExecs.reduce((s, e) => s + e.waitedSeconds, 0) / recentExecs.length)
    : 0;

  // Risk concentration: how many providers carry most of the offers.
  const providerOfferCounts = await db.liquidityOffer.groupBy({
    by: ["providerId"],
    where: { active: true },
    _count: true,
  });
  const sortedCounts = providerOfferCounts.map((p) => p._count).sort((a, b) => b - a);
  const topProviderShare = sortedCounts.length > 0 && sortedCounts[0] > 0
    ? sortedCounts[0] / sortedCounts.reduce((s, c) => s + c, 0)
    : 1;
  const riskConcentration = Math.round((1 - topProviderShare) * 100); // higher = more diverse

  // Overall: weighted composite.
  const overall = Math.round(
    liquidityDepth * 0.20 +
    routeCompetition * 0.20 +
    providerReliability * 0.20 +
    executionSuccess * 0.20 +
    riskConcentration * 0.10 +
    Math.max(0, 100 - averageWait / 10) * 0.10
  );

  return {
    liquidityDepth: Math.round(liquidityDepth),
    routeCompetition: Math.round(routeCompetition),
    providerReliability: Math.round(providerReliability),
    executionSuccess: Math.round(executionSuccess),
    averageWait,
    riskConcentration,
    overall,
    components: {
      liquidityDepth: Math.round(liquidityDepth),
      routeCompetition: Math.round(routeCompetition),
      providerReliability: Math.round(providerReliability),
      executionSuccess: Math.round(executionSuccess),
      riskConcentration,
    },
  };
}

// ---- Network unit economics --------------------------------------------
export async function getNetworkUnitEconomics(): Promise<any> {
  const completedExecs = await db.execution.findMany({
    where: { status: "COMPLETED" },
    include: { intent: true, legs: { include: { offer: true } } },
    take: 200,
    orderBy: { completedAt: "desc" },
  });

  const totalVolume = completedExecs.reduce((s, e) => s + Number(e.intent.sourceAmount.toString()), 0);
  const totalFees = completedExecs.reduce((s, e) => {
    return s + e.legs.reduce((ls, l) => ls + (l.offer ? Number(l.amount.toString()) * l.offer.feeBps / 10000 : 0), 0);
  }, 0);

  // Corridor economics.
  const corridorMap = new Map<string, { volume: number; count: number; fees: number; completed: number }>();
  for (const e of completedExecs) {
    const key = `${e.intent.sourceAsset}→${e.intent.destinationAsset}`;
    const cur = corridorMap.get(key) ?? { volume: 0, count: 0, fees: 0, completed: 0 };
    cur.volume += Number(e.intent.sourceAmount.toString());
    cur.count++;
    cur.completed++;
    cur.fees += e.legs.reduce((s, l) => s + (l.offer ? Number(l.amount.toString()) * l.offer.feeBps / 10000 : 0), 0);
    corridorMap.set(key, cur);
  }

  return {
    totalVolume,
    completedCount: completedExecs.length,
    totalFees: totalFees.toFixed(2),
    avgCostBps: totalVolume > 0 ? Math.round((totalFees / totalVolume) * 10000) : 0,
    corridors: [...corridorMap.entries()]
      .map(([corridor, v]) => ({
        corridor,
        volume: v.volume.toFixed(2),
        count: v.count,
        fees: v.fees.toFixed(2),
        avgTakeRateBps: v.volume > 0 ? Math.round((v.fees / v.volume) * 10000) : 0,
      }))
      .sort((a, b) => Number(b.volume) - Number(a.volume))
      .slice(0, 15),
  };
}

// ---- Provider acquisition funnel ---------------------------------------
export async function getProviderFunnel(): Promise<any> {
  const providers = await db.liquidityProvider.findMany({
    select: {
      id: true,
      status: true,
      createdAt: true,
      offers: { select: { id: true, createdAt: true } },
      legs: { select: { id: true, execution: { select: { status: true, startedAt: true } } } },
    },
  });

  const funnel = {
    applied: 0,
    approved: 0,
    connected: 0,
    publishedOffer: 0,
    receivedExecution: 0,
    completedExecution: 0,
    repeatProvider: 0,
  };

  for (const p of providers) {
    if (["APPLIED", "REVIEW", "APPROVED", "ACTIVE", "SUSPENDED"].includes(p.status)) funnel.applied++;
    if (["APPROVED", "ACTIVE", "SUSPENDED"].includes(p.status)) funnel.approved++;
    if (p.status === "ACTIVE") funnel.connected++;
    if (p.offers.length > 0) funnel.publishedOffer++;
    if (p.legs.length > 0) funnel.receivedExecution++;
    const completed = p.legs.filter((l) => l.execution?.status === "COMPLETED").length;
    if (completed > 0) funnel.completedExecution++;
    if (completed > 1) funnel.repeatProvider++;
  }

  return {
    ...funnel,
    conversionRates: {
      appliedToApproved: funnel.applied > 0 ? Math.round((funnel.approved / funnel.applied) * 100) : 0,
      approvedToConnected: funnel.approved > 0 ? Math.round((funnel.connected / funnel.approved) * 100) : 0,
      connectedToPublished: funnel.connected > 0 ? Math.round((funnel.publishedOffer / funnel.connected) * 100) : 0,
      publishedToFirstExecution: funnel.publishedOffer > 0 ? Math.round((funnel.receivedExecution / funnel.publishedOffer) * 100) : 0,
      firstToRepeat: funnel.receivedExecution > 0 ? Math.round((funnel.repeatProvider / funnel.receivedExecution) * 100) : 0,
    },
  };
}
