// MarketIntelligenceService — demand pressure, liquidity gaps, provider
// opportunities, pricing intelligence.
//
// ARCHITECTURE RULE: all data is derived from existing ExecutionIntent,
// LiquidityOffer, and Execution entities. No parallel marketplace data.

import { db } from "@/lib/db";
import { Decimal } from "@/lib/engine/money";

// ---- Demand pressure per corridor --------------------------------------
// Aggregates pending WAIT_FOR_BETTER intents by corridor.
export async function getDemandPressure(): Promise<any[]> {
  const waiting = await db.executionIntent.findMany({
    where: {
      status: "ACTIVE",
      executions: { some: { status: "SEARCHING" } },
    },
    select: {
      sourceAsset: true,
      destinationAsset: true,
      sourceCountry: true,
      destinationCountry: true,
      sourceAmount: true,
    },
  });

  const byCorridor = new Map<string, { demand: number; count: number; sourceAsset: string; destinationAsset: string; sourceCountry: string; destinationCountry: string }>();
  for (const w of waiting) {
    const key = `${w.sourceAsset}:${w.sourceCountry}→${w.destinationAsset}:${w.destinationCountry}`;
    const cur = byCorridor.get(key) ?? { demand: 0, count: 0, sourceAsset: w.sourceAsset, destinationAsset: w.destinationAsset, sourceCountry: w.sourceCountry, destinationCountry: w.destinationCountry };
    cur.demand += Number(w.sourceAmount.toString());
    cur.count++;
    byCorridor.set(key, cur);
  }

  // Match each demand corridor with available supply.
  const result: Array<{
    corridor: string; sourceAsset: string; destinationAsset: string;
    sourceCountry: string; destinationCountry: string;
    demandAmount: number; demandCount: number; supplyAmount: number;
    gap: number; status: string;
  }> = [];
  for (const [corridor, d] of byCorridor) {
    const supply = await getCorridorSupply(d.sourceAsset, d.destinationAsset, d.sourceCountry, d.destinationCountry);
    const gap = d.demand - supply;
    result.push({
      corridor,
      sourceAsset: d.sourceAsset,
      destinationAsset: d.destinationAsset,
      sourceCountry: d.sourceCountry,
      destinationCountry: d.destinationCountry,
      demandAmount: d.demand,
      demandCount: d.count,
      supplyAmount: supply,
      gap: gap,
      status: gap > 0 ? "UNDERSUPPLIED" : "OVERSUPPLIED",
    });
  }
  return result.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
}

async function getCorridorSupply(srcAsset: string, dstAsset: string, srcCountry: string, dstCountry: string): Promise<number> {
  const offers = await db.liquidityOffer.findMany({
    where: {
      active: true,
      provider: { status: "ACTIVE" },
      OR: [
        { sourceAsset: srcAsset, destinationAsset: dstAsset },
        { sourceAsset: srcAsset }, // any offer that takes the source asset
      ],
    },
    select: { availableCapacity: true, reservedCapacity: true },
  });
  return offers.reduce((s, o) => s + (Number(o.availableCapacity.toString()) - Number(o.reservedCapacity.toString())), 0);
}

// ---- Liquidity gap engine ----------------------------------------------
// Returns corridors with the largest demand/supply imbalance.
export async function getLiquidityGaps(limit = 20): Promise<any[]> {
  const pressure = await getDemandPressure();
  return pressure
    .filter((p) => p.gap > 0)
    .slice(0, limit)
    .map((p) => ({
      corridor: p.corridor,
      demand: p.demandAmount,
      supply: p.supplyAmount,
      gap: p.gap,
      gapPct: p.supply > 0 ? Math.round((p.gap / p.demand) * 100) : 100,
      demandCount: p.demandCount,
    }));
}

// ---- Provider opportunity feed -----------------------------------------
// Shows providers where they could make money (high demand, low supply).
export async function getProviderOpportunities(): Promise<any[]> {
  const gaps = await getLiquidityGaps(20);
  // For each gap, compute the estimated spread (median fee on that corridor).
  const opportunities: Array<{
    corridor: string; demandAmount: number; supplyAmount: number;
    gap: number; gapPct: number; estimatedSpreadBps: number;
    opportunity: string; note: string;
  }> = [];
  for (const g of gaps) {
    const [srcAsset, dstAsset] = g.corridor.includes("→") ? g.corridor.split("→")[0].split(":")[0].trim() : [g.sourceAsset, g.destinationAsset];
    const offers = await db.liquidityOffer.findMany({
      where: { active: true, sourceAsset: srcAsset, destinationAsset: dstAsset },
      select: { feeBps: true },
    });
    const medianFee = offers.length > 0
      ? offers.map((o) => o.feeBps).sort((a, b) => a - b)[Math.floor(offers.length / 2)]
      : 30; // default estimated spread for underserved corridors
    opportunities.push({
      corridor: g.corridor,
      demandAmount: g.demand,
      supplyAmount: g.supply,
      gap: g.gap,
      gapPct: g.gapPct,
      estimatedSpreadBps: medianFee,
      opportunity: g.gapPct > 50 ? "HIGH" : g.gapPct > 25 ? "MEDIUM" : "LOW",
      note: "Indicative opportunity — not a profitability guarantee.",
    });
  }
  return opportunities;
}

// ---- Pricing intelligence ----------------------------------------------
// Shows the competitive landscape for a corridor.
export async function getPricingIntelligence(sourceAsset: string, destinationAsset: string): Promise<any> {
  const offers = await db.liquidityOffer.findMany({
    where: { active: true, sourceAsset, destinationAsset, provider: { status: "ACTIVE" } },
    include: { provider: { select: { name: true, providerType: true, reputationScore: true, tier: true } } },
    orderBy: { feeBps: "asc" },
  });

  if (offers.length === 0) {
    return { corridor: `${sourceAsset}→${destinationAsset}`, offerCount: 0, message: "No active offers on this corridor." };
  }

  const fees = offers.map((o) => o.feeBps).sort((a, b) => a - b);
  const cheapest = fees[0];
  const median = fees[Math.floor(fees.length / 2)];
  const mostExpensive = fees[fees.length - 1];
  const fastest = offers.reduce((min, o) => o.expectedExecutionSeconds < min.expectedExecutionSeconds ? o : min, offers[0]);

  // Recent fills on this corridor.
  const recentFills = await db.leg.findMany({
    where: { sourceAsset, destinationAsset, execution: { status: "COMPLETED" } },
    include: { execution: { select: { completedAt: true, intent: { select: { sourceAmount: true } } } }, offer: { select: { feeBps: true } } },
    orderBy: { execution: { completedAt: "desc" } },
    take: 10,
  });

  return {
    corridor: `${sourceAsset}→${destinationAsset}`,
    offerCount: offers.length,
    cheapestFeeBps: cheapest,
    medianFeeBps: median,
    mostExpensiveFeeBps: mostExpensive,
    fastestExecutionSeconds: fastest.expectedExecutionSeconds,
    fastestProvider: fastest.provider.name,
    offers: offers.map((o) => ({
      provider: o.provider.name,
      providerType: o.provider.providerType,
      tier: o.provider.tier,
      reputation: o.provider.reputationScore,
      feeBps: o.feeBps,
      rate: o.rate.toString(),
      availableCapacity: o.availableCapacity.toString(),
      channelType: o.channelType,
      expectedExecutionSeconds: o.expectedExecutionSeconds,
    })),
    recentFills: recentFills.map((f) => ({
      amount: f.execution?.intent.sourceAmount.toString() ?? "0",
      feeBps: f.offer?.feeBps,
      completedAt: f.execution?.completedAt ?? null,
    })),
  };
}

// ---- Quote win/loss analytics ------------------------------------------
// Record a quote result when a route is selected.
export async function recordQuoteResult(input: {
  executionId: string;
  winnerProviderId: string;
  winnerFeeBps: number;
  winnerExecutionSeconds: number;
  allProviders: Array<{ providerId: string; offerId?: string; feeBps: number; executionSeconds: number; corridor: string }>;
}): Promise<void> {
  for (const p of input.allProviders) {
    const won = p.providerId === input.winnerProviderId;
    await db.quoteWinLoss.create({
      data: {
        providerId: p.providerId,
        executionId: input.executionId,
        offerId: p.offerId ?? null,
        corridor: p.corridor,
        result: won ? "WON" : "LOST",
        winnerProviderId: input.winnerProviderId,
        winnerFeeBps: input.winnerFeeBps,
        winnerExecutionSeconds: input.winnerExecutionSeconds,
        ourFeeBps: p.feeBps,
        ourExecutionSeconds: p.executionSeconds,
        reasonLost: won ? null : determineLossReason(p, input.winnerFeeBps, input.winnerExecutionSeconds),
      },
    });
  }
}

function determineLossReason(our: { feeBps: number; executionSeconds: number }, winnerFee: number, winnerSpeed: number): string {
  if (our.feeBps > winnerFee * 1.1) return "higher_cost";
  if (our.executionSeconds > winnerSpeed * 1.5) return "slower";
  return "less_competitive";
}

// Get win/loss summary for a provider.
export async function getQuoteWinLossSummary(providerId: string): Promise<any> {
  const records = await db.quoteWinLoss.findMany({
    where: { providerId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const wins = records.filter((r) => r.result === "WON").length;
  const losses = records.filter((r) => r.result === "LOST").length;
  const lossReasons = records
    .filter((r) => r.reasonLost)
    .reduce((acc, r) => {
      acc[r.reasonLost!] = (acc[r.reasonLost!] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  return {
    totalQuotes: records.length,
    wins,
    losses,
    winRate: records.length > 0 ? Math.round((wins / records.length) * 100) / 100 : 0,
    lossReasons,
    recentResults: records.slice(0, 10).map((r) => ({
      corridor: r.corridor,
      result: r.result,
      ourFeeBps: r.ourFeeBps,
      winnerFeeBps: r.winnerFeeBps,
      reasonLost: r.reasonLost,
      createdAt: r.createdAt,
    })),
  };
}
