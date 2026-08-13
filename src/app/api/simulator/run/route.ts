import { NextRequest, NextResponse } from "next/server";
import { runSimulation } from "@/lib/simulator/engine-faithful";
import { createDefaultConfig, SimConfig } from "@/lib/simulator/world";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json().catch(() => ({}));
  const config: SimConfig = { ...createDefaultConfig(), ...body };

  try {
    const world = runSimulation(config);
    const finalMetrics = world.metricsHistory[world.metricsHistory.length - 1] ?? {
      totalIntents: 0, completedIntents: 0, failedIntents: 0, cancelledIntents: 0,
      expiredIntents: 0, avgCostBps: 0, avgWaitSteps: 0, p50ExecutionSteps: 0,
      p95ExecutionSteps: 0, completionRate: 0, activeProviders: 0, exitedProviders: 0,
      suspendedProviders: 0, economicExits: 0,
      avgProviderEarnings: 0, medianProviderEarnings: 0, avgUtilization: 0,
      peakUtilization: 0, avgTimeWeightedUtilization: 0,
      totalProviderVolume: 0, totalProtocolRevenue: 0, totalIncentiveSpend: 0,
      medianNetProfit: 0, avgNetProfit: 0, medianNetMargin: 0,
      medianProfitPerExecution: 0, medianAnnualizedReturnPct: 0,
      medianCapitalEfficiency: 0,
      totalLiquidity: 0, avgRoutesPerCorridor: 0, corridorCoverage: 0,
      marketConcentration: 0, equilibriumStatus: "FORMING",
    };

    // Corridor analysis.
    const corridorMap = new Map<string, { demand: number; supply: number; completed: number; failed: number; avgCost: number }>();
    for (const intent of world.intents) {
      const key = `${intent.sourceAsset}:${intent.sourceCountry}→${intent.destinationAsset}:${intent.destinationCountry}`;
      const cur = corridorMap.get(key) ?? { demand: 0, supply: 0, completed: 0, failed: 0, avgCost: 0 };
      cur.demand++;
      if (intent.status === "COMPLETED") { cur.completed++; cur.avgCost += intent.effectiveCost / intent.sourceAmount * 10000; }
      if (intent.status === "FAILED" || intent.status === "EXPIRED") cur.failed++;
      corridorMap.set(key, cur);
    }
    for (const [key, val] of corridorMap.entries()) {
      if (val.completed > 0) val.avgCost /= val.completed;
    }

    // Provider analysis.
    const providers = [...world.providers.values()].map(p => ({
      name: p.name, type: p.providerType, strategy: p.strategy, tier: p.tier,
      status: p.status, exitReason: p.exitReason,
      reputation: Math.round(p.reputationScore * 100) / 100,
      volume: Math.round(p.totalVolume * 100) / 100,
      earnings: Math.round(p.totalEarnings * 100) / 100,
      incentives: Math.round(p.totalIncentives * 100) / 100,
      executions: p.executionsCompleted, failures: p.executionsFailed,
      utilization: Math.round(p.utilization * 10000) / 100,
      entryStep: p.entryStep, exitStep: p.exitStep,
    })).sort((a, b) => b.volume - a.volume);

    return NextResponse.json({
      config,
      metrics: finalMetrics,
      metricsHistory: world.metricsHistory,
      corridors: [...corridorMap.entries()]
        .map(([corridor, v]) => ({ corridor, ...v, avgCostBps: Math.round(v.avgCost * 100) / 100 }))
        .sort((a, b) => b.demand - a.demand)
        .slice(0, 20),
      providers,
      totalIntents: world.intents.length,
      seed: config.seed,
      steps: config.totalSteps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "simulation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
