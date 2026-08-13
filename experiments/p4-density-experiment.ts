// dRamp Prompt 4.8 — Controlled Provider-Density Experiment
//
// Runs identical simulation worlds with 5, 10, 15, 20, 30, 50, 80, 100 providers.
// All controls fixed: no entry/exit, no incentives, no shocks.
// 20 independent seeds per density. Reports mean/median/p10/p90.
//
// Usage: bun experiments/p4-density-experiment.ts

import { runSimulation } from "../src/lib/simulator/engine-faithful";
import { createDefaultConfig, toUsdValue } from "../src/lib/simulator/world";
import { calculateProviderEconomics } from "../src/lib/economics/shared";

// ---- Controlled config: all dynamics OFF, only provider density varies ----
function makeControlledConfig(seed: number, providerCount: number) {
  return {
    ...createDefaultConfig(),
    seed,
    totalSteps: 100,
    stepDurationMs: 60000,
    initialProviders: providerCount,
    providerGrowthRate: 0.0,        // entry OFF
    providerExitThreshold: -999,    // exit OFF (threshold below any possible return)
    demandVolume: 10,
    demandGrowth: 0.0,
    riskDistribution: { maxReliability: 0.25, balanced: 0.60, lowestCost: 0.15 },
    policyDistribution: { now: 0.70, waitForBetter: 0.30 },
    enableReputation: true,
    enableCommitments: true,
    enableIncentives: false,         // incentives OFF
    shockType: null,                 // shocks OFF
    shockStep: 999,
    shockMagnitude: 0,
    baselineCostBps: 300,
    enableLiquidityInventory: true,
    enableStochasticSettlement: true,
    enableDemandPatience: true,
    defaultMaxAcceptablePriceBps: 400,
    defaultMaxAcceptableLatencySteps: 30,
    liquidityReplenishSteps: 10,
  };
}

// ---- Metrics extraction ----
interface RunMetrics {
  // User
  routeCoverage: number;        // % of intents that found at least one route
  completionRate: number;       // % completed
  abandonmentRate: number;      // % abandoned
  avgCostBps: number;
  p50LatencySteps: number;
  p95LatencySteps: number;
  avgOutputAmount: number;
  userSurplus: number;          // $ saved vs baseline
  // Provider
  avgUtilization: number;
  medianUtilization: number;
  medianNetProfit: number;
  medianNetMargin: number;
  earningsPer1kDeployed: number;
  capitalTurnover: number;
  // Network
  totalVolume: number;
  activeProviders: number;
  hhi: number;
  routeCompetition: number;     // avg offers per corridor
  protocolRevenue: number;
  liquidityDepth: number;       // total available capacity
}

function extractMetrics(world: any): RunMetrics {
  const m = world.metricsHistory[world.metricsHistory.length - 1];
  const intents = world.intents;
  const completed = intents.filter((i: any) => i.status === "COMPLETED");
  const abandoned = intents.filter((i: any) => i.status === "ABANDONED");
  const expired = intents.filter((i: any) => i.status === "EXPIRED");
  const foundRoute = intents.filter((i: any) => i.status === "COMPLETED" || i.status === "EXECUTING" || i.status === "FAILED");

  const costs = completed.map((i: any) => i.effectiveCost / i.sourceAmount * 10000);
  const avgCostBps = costs.length > 0 ? costs.reduce((s: number, c: number) => s + c, 0) / costs.length : 0;

  const latencies = completed.map((i: any) => i.completedAtStep! - i.createdAtStep).sort((a: number, b: number) => a - b);
  const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  const outputs = completed.map((i: any) => i.netOutput);
  const avgOutput = outputs.length > 0 ? outputs.reduce((s: number, o: number) => s + o, 0) / outputs.length : 0;

  let userSurplus = 0;
  for (const i of completed) {
    const actualCostBps = i.effectiveCost / i.sourceAmount * 10000;
    const savingsBps = 300 - actualCostBps; // baseline = 300 bps
    if (savingsBps > 0) userSurplus += i.sourceAmount * savingsBps / 10000;
  }

  const activeProviders = [...world.providers.values()].filter((p: any) => p.status === "ACTIVE");
  const stepsPerYear = (365 * 24 * 60) / (world.config.stepDurationMs / 60000);

  const providerEcons = activeProviders.map((p: any) => {
    const elapsedSteps = Math.max(1, world.step - p.entryStep);
    const avgDeployed = p.totalDeployedCapitalSteps / elapsedSteps;
    return calculateProviderEconomics({
      grossFees: p.totalEarnings,
      incentives: p.totalIncentives,
      rebates: 0,
      settlementCosts: p.totalVolume * 0.0001,
      operatingCosts: p.totalVolume * 0.0002,
      capitalCostRate: 0.05,
      averageDeployedCapital: avgDeployed,
      expectedLossRate: 0.001,
      penalties: p.totalPenalties,
      slashing: p.totalSlashing,
      stepsPerYear,
    });
  });

  const utils = activeProviders.map((p: any) => p.utilization).sort((a: number, b: number) => a - b);
  const profits = providerEcons.map((e: any) => e.netEarnings).sort((a: number, b: number) => a - b);
  const margins = providerEcons.filter((e: any) => e.grossEarnings > 0).map((e: any) => (e.netEarnings / e.grossEarnings) * 100).sort((a: number, b: number) => a - b);

  const totalLiquidity = [...world.offers.values()].filter((o: any) => o.active).reduce((s: number, o: any) => s + o.availableCapacity, 0);
  const providerVolumes = activeProviders.map((p: any) => p.totalVolume);
  const totalVol = providerVolumes.reduce((s: number, v: number) => s + v, 0);
  const hhi = totalVol > 0 ? providerVolumes.map((v: number) => (v / totalVol) ** 2).reduce((s: number, h: number) => s + h, 0) : 1;

  // Route competition: avg active offers per (sourceAsset → destinationAsset) pair
  const corridorOffers = new Map<string, number>();
  for (const o of world.offers.values()) {
    if (!o.active) continue;
    const key = `${o.sourceAsset}→${o.destinationAsset}`;
    corridorOffers.set(key, (corridorOffers.get(key) ?? 0) + 1);
  }
  const routeCompetition = corridorOffers.size > 0
    ? [...corridorOffers.values()].reduce((s, c) => s + c, 0) / corridorOffers.size
    : 0;

  const median = (arr: number[]) => arr.length > 0 ? arr[Math.floor(arr.length / 2)] : 0;

  return {
    routeCoverage: intents.length > 0 ? (foundRoute.length / intents.length) * 100 : 0,
    completionRate: intents.length > 0 ? (completed.length / intents.length) * 100 : 0,
    abandonmentRate: intents.length > 0 ? (abandoned.length / intents.length) * 100 : 0,
    avgCostBps: Math.round(avgCostBps * 100) / 100,
    p50LatencySteps: p50,
    p95LatencySteps: p95,
    avgOutputAmount: Math.round(avgOutput * 100) / 100,
    userSurplus: Math.round(userSurplus * 100) / 100,
    avgUtilization: utils.length > 0 ? Math.round((utils.reduce((s: number, u: number) => s + u, 0) / utils.length) * 10000) / 100 : 0,
    medianUtilization: median(utils) * 100,
    medianNetProfit: Math.round(median(profits) * 100) / 100,
    medianNetMargin: Math.round(median(margins) * 100) / 100,
    earningsPer1kDeployed: providerEcons.length > 0
      ? Math.round((providerEcons.reduce((s: number, e: any) => s + e.netEarnings, 0) / providerEcons.length) / Math.max(1, activeProviders.reduce((s: number, p: any) => s + p.usableCollateral, 0) / activeProviders.length / 1000) * 100) / 100
      : 0,
    capitalTurnover: providerEcons.length > 0
      ? Math.round(median(providerEcons.map((e: any) => {
          const avgCap = activeProviders[0]?.usableCollateral ?? 1;
          return avgCap > 0 ? totalVol / avgCap / activeProviders.length : 0;
        })) * 100) / 100
      : 0,
    totalVolume: Math.round(totalVol * 100) / 100,
    activeProviders: activeProviders.length,
    hhi: Math.round(hhi * 10000) / 10000,
    routeCompetition: Math.round(routeCompetition * 100) / 100,
    protocolRevenue: Math.round(world.totalFees * 100) / 100,
    liquidityDepth: Math.round(totalLiquidity * 100) / 100,
  };
}

// ---- Statistical helpers ----
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function fmt(n: number, decimals = 1): string {
  if (Math.abs(n) > 1000000) return (n / 1000000).toFixed(decimals) + "M";
  if (Math.abs(n) > 1000) return (n / 1000).toFixed(decimals) + "k";
  return n.toFixed(decimals);
}

function statsLabel(mean: number, median: number, p10: number, p90: number): string {
  return `${median.toFixed(1)} (${p10.toFixed(1)}–${p90.toFixed(1)})`;
}

// ---- Main experiment ----
const PROVIDER_COUNTS = [5, 10, 15, 20, 30, 50, 80, 100];
const NUM_SEEDS = 20;
const BASE_SEED = 10000;

interface DensityResult {
  providerCount: number;
  runs: RunMetrics[];
}

function runDensityExperiment(): DensityResult[] {
  const results: DensityResult[] = [];
  for (const count of PROVIDER_COUNTS) {
    const runs: RunMetrics[] = [];
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = BASE_SEED + s;
      const config = makeControlledConfig(seed, count);
      const world = runSimulation(config);
      runs.push(extractMetrics(world));
    }
    results.push({ providerCount: count, runs });
    process.stderr.write(`  Done: ${count} providers (${NUM_SEEDS} seeds)\n`);
  }
  return results;
}

function printResults(results: DensityResult[]) {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  dRamp Provider-Density Experiment (Post-Calibration)       ║");
  console.log("║  Simulator: 1c2c133 | 20 seeds per density | 100 steps      ║");
  console.log("║  Controls: no entry/exit, no incentives, no shocks           ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  // ---- Table A: User outcomes ----
  console.log("\n### Table A — User Outcomes vs Provider Density\n");
  console.log("| Providers | Coverage % | Completion % | Abandon % | Avg cost (bps) | P50 latency | P95 latency | User surplus $ |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const cov = r.runs.map(m => m.routeCoverage);
    const comp = r.runs.map(m => m.completionRate);
    const aban = r.runs.map(m => m.abandonmentRate);
    const cost = r.runs.map(m => m.avgCostBps);
    const p50 = r.runs.map(m => m.p50LatencySteps);
    const p95 = r.runs.map(m => m.p95LatencySteps);
    const surp = r.runs.map(m => m.userSurplus);
    console.log(`| ${r.providerCount} | ${statsLabel(0, percentile(cov, 0.5), percentile(cov, 0.1), percentile(cov, 0.9))} | ${statsLabel(0, percentile(comp, 0.5), percentile(comp, 0.1), percentile(comp, 0.9))} | ${statsLabel(0, percentile(aban, 0.5), percentile(aban, 0.1), percentile(aban, 0.9))} | ${statsLabel(0, percentile(cost, 0.5), percentile(cost, 0.1), percentile(cost, 0.9))} | ${statsLabel(0, percentile(p50, 0.5), percentile(p50, 0.1), percentile(p50, 0.9))} | ${statsLabel(0, percentile(p95, 0.5), percentile(p95, 0.1), percentile(p95, 0.9))} | ${statsLabel(0, percentile(surp, 0.5), percentile(surp, 0.1), percentile(surp, 0.9))} |`);
  }

  // ---- Table B: Provider economics ----
  console.log("\n### Table B — Provider Economics vs Provider Density\n");
  console.log("| Providers | Avg util % | Median util % | Median profit $ | Median margin % | Earnings/$1k | Capital turnover |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const au = r.runs.map(m => m.avgUtilization);
    const mu = r.runs.map(m => m.medianUtilization);
    const mp = r.runs.map(m => m.medianNetProfit);
    const mm = r.runs.map(m => m.medianNetMargin);
    const epk = r.runs.map(m => m.earningsPer1kDeployed);
    const ct = r.runs.map(m => m.capitalTurnover);
    console.log(`| ${r.providerCount} | ${statsLabel(0, percentile(au, 0.5), percentile(au, 0.1), percentile(au, 0.9))} | ${statsLabel(0, percentile(mu, 0.5), percentile(mu, 0.1), percentile(mu, 0.9))} | ${statsLabel(0, percentile(mp, 0.5), percentile(mp, 0.1), percentile(mp, 0.9))} | ${statsLabel(0, percentile(mm, 0.5), percentile(mm, 0.1), percentile(mm, 0.9))} | ${statsLabel(0, percentile(epk, 0.5), percentile(epk, 0.1), percentile(epk, 0.9))} | ${statsLabel(0, percentile(ct, 0.5), percentile(ct, 0.1), percentile(ct, 0.9))} |`);
  }

  // ---- Table C: Network structure ----
  console.log("\n### Table C — Network Structure vs Provider Density\n");
  console.log("| Providers | HHI | Route competition | Liquidity depth $ | Total volume $ | Protocol revenue $ |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const hhi = r.runs.map(m => m.hhi);
    const rc = r.runs.map(m => m.routeCompetition);
    const ld = r.runs.map(m => m.liquidityDepth);
    const tv = r.runs.map(m => m.totalVolume);
    const pr = r.runs.map(m => m.protocolRevenue);
    console.log(`| ${r.providerCount} | ${statsLabel(0, percentile(hhi, 0.5), percentile(hhi, 0.1), percentile(hhi, 0.9))} | ${statsLabel(0, percentile(rc, 0.5), percentile(rc, 0.1), percentile(rc, 0.9))} | ${statsLabel(0, percentile(ld, 0.5), percentile(ld, 0.1), percentile(ld, 0.9))} | ${statsLabel(0, percentile(tv, 0.5), percentile(tv, 0.1), percentile(tv, 0.9))} | ${statsLabel(0, percentile(pr, 0.5), percentile(pr, 0.1), percentile(pr, 0.9))} |`);
  }

  // ---- Critical-mass analysis ----
  console.log("\n### Critical-Mass Analysis\n");
  for (const r of results) {
    const coverage90 = r.runs.filter(m => m.routeCoverage >= 90).length;
    const completion90 = r.runs.filter(m => m.completionRate >= 90).length;
    const medianCost = percentile(r.runs.map(m => m.avgCostBps), 0.5);
    const medianCoverage = percentile(r.runs.map(m => m.routeCoverage), 0.5);
    const medianCompletion = percentile(r.runs.map(m => m.completionRate), 0.5);
    console.log(`  ${r.providerCount} providers: coverage=${medianCoverage.toFixed(1)}% (≥90% in ${coverage90}/${NUM_SEEDS} seeds), completion=${medianCompletion.toFixed(1)}% (≥90% in ${completion90}/${NUM_SEEDS}), median cost=${medianCost.toFixed(1)} bps`);
  }

  // ---- Identify thresholds ----
  console.log("\n### Threshold Identification\n");
  const findThreshold = (metric: keyof RunMetrics, target: number, direction: "ge" | "le" = "ge") => {
    for (const r of results) {
      const vals = r.runs.map(m => m[metric] as number);
      const med = percentile(vals, 0.5);
      if (direction === "ge" && med >= target) return r.providerCount;
      if (direction === "le" && med <= target) return r.providerCount;
    }
    return null;
  };

  const cov90 = findThreshold("routeCoverage", 90, "ge");
  const comp90 = findThreshold("completionRate", 90, "ge");
  console.log(`  Route coverage ≥ 90%: ${cov90 ? cov90 + " providers" : "not achieved"}`);
  console.log(`  Completion rate ≥ 90%: ${comp90 ? comp90 + " providers" : "not achieved"}`);

  // Diminishing returns: find where median cost stops improving
  let diminishingReturns: number | null = null;
  const medianCosts = results.map(r => percentile(r.runs.map(m => m.avgCostBps), 0.5));
  for (let i = 1; i < medianCosts.length; i++) {
    const improvement = medianCosts[i - 1] - medianCosts[i];
    const nextImprovement = i + 1 < medianCosts.length ? medianCosts[i] - medianCosts[i + 1] : 0;
    if (improvement > 0 && nextImprovement < improvement * 0.3) {
      diminishingReturns = results[i].providerCount;
      break;
    }
  }
  console.log(`  Diminishing returns on cost: ${diminishingReturns ? diminishingReturns + " providers" : "not clearly identified"}`);

  // ---- Reproducibility info ----
  console.log("\n### Reproducibility\n");
  console.log(`  Simulator commit: 1c2c133`);
  console.log(`  Base seed: ${BASE_SEED}`);
  console.log(`  Seeds per density: ${NUM_SEEDS}`);
  console.log(`  Steps per run: 100`);
  console.log(`  Step duration: 60000ms (1 minute)`);
  console.log(`  Controls: providerGrowthRate=0, providerExitThreshold=-999, enableIncentives=false, shockType=null`);
}

// ---- Run ----
console.log("Running provider-density experiment...");
console.log(`  ${PROVIDER_COUNTS.length} densities × ${NUM_SEEDS} seeds = ${PROVIDER_COUNTS.length * NUM_SEEDS} runs`);
const results = runDensityExperiment();
printResults(results);
console.log("\nExperiment complete.");
