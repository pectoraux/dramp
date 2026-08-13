// dRamp Simulator — Strategic Experiment Runner
//
// Runs 5 experiment groups and outputs markdown tables for analysis.
// Does NOT modify the simulator. Uses the canonical shared economics.

import { simulateStep, runSimulation } from "../src/lib/simulator/engine-faithful";
import { createWorld, createDefaultConfig, SimWorld, SimConfig, SimProvider, SimMetrics } from "../src/lib/simulator/world";
import { generateWorld, generateNewProvider } from "../src/lib/simulator/generator";
import { SeededRNG } from "../src/lib/simulator/rng";
import { calculateProviderEconomics } from "../src/lib/economics/shared";

// ---- Economic parameters (must match engine-faithful.ts) ----
const CAPITAL_COST_RATE = 0.05;
const EXPECTED_LOSS_RATE = 0.001;
const SETTLEMENT_COST_BPS = 1;
const OPERATING_COST_BPS = 2;

// ---- Custom runner (allows world modification before simulation) ----

function runSim(config: SimConfig, modifyWorld?: (w: SimWorld) => void): SimWorld {
  const rng = new SeededRNG(config.seed);
  const world = createWorld(config);
  generateWorld(world, rng);
  if (modifyWorld) modifyWorld(world);
  for (let step = 0; step < config.totalSteps; step++) {
    simulateStep(world, rng);
  }
  return world;
}

// ---- Metric computation ----

interface ComputedMetrics {
  avgCostBps: number;
  p95ExecutionSteps: number;
  completionRate: number;
  activeProviders: number;
  exitedProviders: number;
  medianRiskAdjustedReturn: number;  // annualized %
  avgRiskAdjustedReturn: number;
  avgUtilization: number;
  hhi: number;
  incentiveSpend: number;
  totalVolume: number;
  userSurplus: number;               // $ saved vs baseline
  providerNetEarnings: number;        // total $ net earnings (active providers)
  protocolRevenue: number;            // total fees (potential at 100% take rate)
  equilibrium: string;
}

function computeMetrics(world: SimWorld): ComputedMetrics {
  const m = world.metricsHistory[world.metricsHistory.length - 1];
  const stepsPerYear = (365 * 24 * 3600 * 1000) / world.config.stepDurationMs;

  // Provider risk-adjusted returns
  const returns: number[] = [];
  let totalNetEarnings = 0;
  for (const p of world.providers.values()) {
    if (p.status !== "ACTIVE") continue;
    const econ = calculateProviderEconomics({
      grossFees: p.totalEarnings,
      incentives: p.totalIncentives,
      rebates: 0,
      settlementCosts: p.totalVolume * SETTLEMENT_COST_BPS / 10000,
      operatingCosts: p.totalVolume * OPERATING_COST_BPS / 10000,
      capitalCostRate: CAPITAL_COST_RATE,
      averageDeployedCapital: p.usableCollateral,
      expectedLossRate: EXPECTED_LOSS_RATE,
      penalties: p.totalPenalties,
      slashing: p.totalSlashing,
      stepsPerYear,
    });
    returns.push(econ.riskAdjustedReturn);
    totalNetEarnings += econ.netEarnings;
  }
  returns.sort((a, b) => a - b);
  const medianReturn = returns.length > 0 ? returns[Math.floor(returns.length / 2)] : 0;
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;

  // User surplus: $ saved vs baseline
  const baseline = world.config.baselineCostBps;
  let userSurplus = 0;
  for (const intent of world.intents) {
    if (intent.status !== "COMPLETED") continue;
    const actualCostBps = intent.effectiveCost / intent.sourceAmount * 10000;
    const savingsBps = baseline - actualCostBps;
    if (savingsBps > 0) {
      userSurplus += intent.sourceAmount * savingsBps / 10000;
    }
  }

  return {
    avgCostBps: m.avgCostBps,
    p95ExecutionSteps: m.p95ExecutionSteps,
    completionRate: m.completionRate,
    activeProviders: m.activeProviders,
    exitedProviders: m.exitedProviders,
    medianRiskAdjustedReturn: medianReturn * 100,
    avgRiskAdjustedReturn: avgReturn * 100,
    avgUtilization: m.avgUtilization,
    hhi: m.marketConcentration,
    incentiveSpend: m.totalIncentiveSpend,
    totalVolume: world.totalVolume,
    userSurplus,
    providerNetEarnings: totalNetEarnings,
    protocolRevenue: world.totalFees,
    equilibrium: m.equilibriumStatus,
  };
}

// ---- Table formatting ----

function fmt(n: number, decimals = 1): string {
  if (Math.abs(n) > 1000000) return (n / 1000000).toFixed(decimals) + "M";
  if (Math.abs(n) > 1000) return (n / 1000).toFixed(decimals) + "k";
  return n.toFixed(decimals);
}

function printTable(title: string, headers: string[], rows: string[][]): void {
  console.log(`\n### ${title}\n`);
  const headerLine = "| " + headers.join(" | ") + " |";
  const divider = "| " + headers.map(() => "---").join(" | ") + " |";
  console.log(headerLine);
  console.log(divider);
  for (const row of rows) {
    console.log("| " + row.join(" | ") + " |");
  }
}

// ---- Experiment 1: Provider Density ----

function experiment1_providerDensity() {
  console.log("\n\n========================================");
  console.log("  EXPERIMENT 1: PROVIDER DENSITY");
  console.log("  (5 → 10 → 25 → 50 → 100 providers)");
  console.log("========================================");

  const sizes = [5, 10, 25, 50, 100];
  const results: ComputedMetrics[] = [];

  for (const n of sizes) {
    const config = { ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: n, providerGrowthRate: 0.0 };
    const world = runSimulation(config);
    results.push(computeMetrics(world));
  }

  printTable("Provider Density — User Outcomes",
    ["Metric", "5 prov", "10 prov", "25 prov", "50 prov", "100 prov"],
    [
      ["Avg user cost (bps)", ...results.map(r => r.avgCostBps.toFixed(1))],
      ["P95 execution (steps)", ...results.map(r => r.p95ExecutionSteps.toString())],
      ["Completion rate (%)", ...results.map(r => r.completionRate.toFixed(1))],
      ["User surplus ($)", ...results.map(r => fmt(r.userSurplus, 0))],
      ["Equilibrium", ...results.map(r => r.equilibrium)],
    ]);

  printTable("Provider Density — Provider Outcomes",
    ["Metric", "5 prov", "10 prov", "25 prov", "50 prov", "100 prov"],
    [
      ["Active providers", ...results.map(r => r.activeProviders.toString())],
      ["Exited providers", ...results.map(r => r.exitedProviders.toString())],
      ["Median net return (%/yr)", ...results.map(r => r.medianRiskAdjustedReturn.toFixed(1))],
      ["Avg net return (%/yr)", ...results.map(r => r.avgRiskAdjustedReturn.toFixed(1))],
      ["Avg utilization (%)", ...results.map(r => r.avgUtilization.toFixed(1))],
      ["Provider net earnings ($)", ...results.map(r => fmt(r.providerNetEarnings, 0))],
    ]);

  printTable("Provider Density — Network Outcomes",
    ["Metric", "5 prov", "10 prov", "25 prov", "50 prov", "100 prov"],
    [
      ["Total volume ($)", ...results.map(r => fmt(r.totalVolume, 0))],
      ["Total liquidity ($)", ...results.map(r => fmt(results[results.indexOf(r)].totalVolume, 0))],
      ["HHI (concentration)", ...results.map(r => r.hhi.toFixed(3))],
      ["Incentive spend ($)", ...results.map(r => fmt(r.incentiveSpend, 0))],
      ["Protocol revenue ($)", ...results.map(r => fmt(r.protocolRevenue, 0))],
    ]);

  // Three-sided surplus
  printTable("Provider Density — Three-Sided Surplus ($)",
    ["Side", "5 prov", "10 prov", "25 prov", "50 prov", "100 prov"],
    [
      ["User surplus", ...results.map(r => fmt(r.userSurplus, 0))],
      ["Provider net earnings", ...results.map(r => fmt(r.providerNetEarnings, 0))],
      ["Protocol revenue (100% take)", ...results.map(r => fmt(r.protocolRevenue, 0))],
      ["Protocol revenue (15% take)", ...results.map(r => fmt(r.protocolRevenue * 0.15, 0))],
    ]);
}

// ---- Experiment 2: Cold-Start Analysis ----

function experiment2_coldStart() {
  console.log("\n\n========================================");
  console.log("  EXPERIMENT 2: COLD-START ANALYSIS");
  console.log("  (5 providers — time series + with/without incentives)");
  console.log("========================================");

  // Time series for 5 providers
  const world = runSimulation({ ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 5, providerGrowthRate: 0.0 });
  const timeSeries = world.metricsHistory;

  printTable("Cold Start — Time Series (5 providers, every 10 steps)",
    ["Step", "Cost (bps)", "Completion (%)", "Active prov", "Liquidity ($)", "Equilibrium"],
    timeSeries.filter((_, i) => i % 2 === 0).slice(0, 11).map(m => [
      (m.totalIntents > 0 ? "*" : "?"),
      m.avgCostBps.toFixed(1),
      m.completionRate.toFixed(1),
      m.activeProviders.toString(),
      fmt(m.totalLiquidity, 0),
      m.equilibriumStatus,
    ]));

  // Fix the step column
  printTable("Cold Start — Time Series (5 providers)",
    ["Step", "Cost (bps)", "Completion (%)", "Active prov", "Liquidity ($)", "HHI", "Equilibrium"],
    timeSeries.filter((_, i) => i % 2 === 0).map((m, i) => [
      ((i * 2 + 1) * 5).toString(),
      m.avgCostBps.toFixed(1),
      m.completionRate.toFixed(1),
      m.activeProviders.toString(),
      fmt(m.totalLiquidity, 0),
      m.marketConcentration.toFixed(3),
      m.equilibriumStatus,
    ]));

  // With vs without incentives at 5 providers
  const withInc = runSimulation({ ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 5, providerGrowthRate: 0.0, enableIncentives: true });
  const withoutInc = runSimulation({ ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 5, providerGrowthRate: 0.0, enableIncentives: false });
  const mInc = computeMetrics(withInc);
  const mNoInc = computeMetrics(withoutInc);

  printTable("Cold Start — Incentive Impact (5 providers)",
    ["Metric", "With incentives", "Without incentives", "Δ"],
    [
      ["Avg user cost (bps)", mInc.avgCostBps.toFixed(1), mNoInc.avgCostBps.toFixed(1), (mInc.avgCostBps - mNoInc.avgCostBps).toFixed(1)],
      ["Completion rate (%)", mInc.completionRate.toFixed(1), mNoInc.completionRate.toFixed(1), (mInc.completionRate - mNoInc.completionRate).toFixed(1)],
      ["Active providers", mInc.activeProviders.toString(), mNoInc.activeProviders.toString(), (mInc.activeProviders - mNoInc.activeProviders).toString()],
      ["Median return (%/yr)", mInc.medianRiskAdjustedReturn.toFixed(1), mNoInc.medianRiskAdjustedReturn.toFixed(1), (mInc.medianRiskAdjustedReturn - mNoInc.medianRiskAdjustedReturn).toFixed(1)],
      ["Total volume ($)", fmt(mInc.totalVolume, 0), fmt(mNoInc.totalVolume, 0), fmt(mInc.totalVolume - mNoInc.totalVolume, 0)],
      ["Equilibrium", mInc.equilibrium, mNoInc.equilibrium, ""],
    ]);

  // With growth vs without growth
  const withGrowth = runSimulation({ ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 5, providerGrowthRate: 0.05 });
  const mGrowth = computeMetrics(withGrowth);
  printTable("Cold Start — Growth Impact (start at 5 providers)",
    ["Metric", "No growth", "5% growth/step"],
    [
      ["Active providers (final)", mNoInc.activeProviders.toString(), mGrowth.activeProviders.toString()],
      ["Avg user cost (bps)", mNoInc.avgCostBps.toFixed(1), mGrowth.avgCostBps.toFixed(1)],
      ["Completion rate (%)", mNoInc.completionRate.toFixed(1), mGrowth.completionRate.toFixed(1)],
      ["Median return (%/yr)", mNoInc.medianRiskAdjustedReturn.toFixed(1), mGrowth.medianRiskAdjustedReturn.toFixed(1)],
      ["HHI", mNoInc.hhi.toFixed(3), mGrowth.hhi.toFixed(3)],
      ["Equilibrium", mNoInc.equilibrium, mGrowth.equilibrium],
    ]);
}

// ---- Experiment 3: Stablecoin Bootstrapping ----

function experiment3_stablecoinBootstrap() {
  console.log("\n\n========================================");
  console.log("  EXPERIMENT 3: STABLECOIN BOOTSTRAPPING");
  console.log("  (0 / 20 / 50 / 100 bps — with expiry at step 60)");
  console.log("========================================");

  const bpsLevels = [0, 20, 50, 100];
  const results: ComputedMetrics[] = [];
  const postExpiryVolumes: number[] = [];

  for (const bps of bpsLevels) {
    const config = { ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 25, providerGrowthRate: 0.0 };
    const world = runSim(config, (w) => {
      if (bps === 0) {
        // Disable all campaigns
        for (const c of w.campaigns.values()) c.status = "EXPIRED";
      } else {
        // Set all campaigns to the target bps, expire at step 60
        for (const c of w.campaigns.values()) {
          c.incentiveBps = bps;
          c.endStep = 60;
          c.totalBudget = 100000; // large budget so it doesn't exhaust
        }
      }
    });
    results.push(computeMetrics(world));

    // Track post-expiry volume (steps 60+)
    let postVol = 0;
    for (const intent of world.intents) {
      if (intent.status === "COMPLETED" && intent.completedAtStep !== null && intent.completedAtStep >= 60) {
        postVol += intent.sourceAmount;
      }
    }
    postExpiryVolumes.push(postVol);
  }

  printTable("Stablecoin Bootstrapping — Full Run (0-100 steps, incentives expire at 60)",
    ["Metric", "0 bps", "20 bps", "50 bps", "100 bps"],
    [
      ["Avg user cost (bps)", ...results.map(r => r.avgCostBps.toFixed(1))],
      ["Completion rate (%)", ...results.map(r => r.completionRate.toFixed(1))],
      ["Total volume ($)", ...results.map(r => fmt(r.totalVolume, 0))],
      ["Incentive spend ($)", ...results.map(r => fmt(r.incentiveSpend, 0))],
      ["Post-expiry volume ($)", ...postExpiryVolumes.map(v => fmt(v, 0))],
      ["Active providers", ...results.map(r => r.activeProviders.toString())],
      ["Median return (%/yr)", ...results.map(r => r.medianRiskAdjustedReturn.toFixed(1))],
      ["Equilibrium", ...results.map(r => r.equilibrium)],
    ]);

  // Survival ratio: post-expiry volume / pre-expiry volume
  const preExpiryVolumes = results.map((r, i) => r.totalVolume - postExpiryVolumes[i]);
  const survivalRatios = postExpiryVolumes.map((post, i) => preExpiryVolumes[i] > 0 ? (post / preExpiryVolumes[i] * 100).toFixed(1) : "0");

  printTable("Stablecoin Bootstrapping — Post-Expiry Survival",
    ["Metric", "0 bps", "20 bps", "50 bps", "100 bps"],
    [
      ["Pre-expiry volume ($)", ...preExpiryVolumes.map(v => fmt(v, 0))],
      ["Post-expiry volume ($)", ...postExpiryVolumes.map(v => fmt(v, 0))],
      ["Survival ratio (%)", ...survivalRatios],
      ["Incentive ROI (vol/inc)", results.map((r, i) => {
        if (r.incentiveSpend === 0) return "N/A";
        const extraVol = r.totalVolume - results[0].totalVolume;
        return (extraVol / r.incentiveSpend).toFixed(1) + "x";
      })],
    ]);
}

// ---- Experiment 4: Volatile Settlement Assets ----

function experiment4_volatileAssets() {
  console.log("\n\n========================================");
  console.log("  EXPERIMENT 4: VOLATILE SETTLEMENT ASSETS");
  console.log("  (WETH offers — MAX_RELIABILITY vs BALANCED vs LOWEST_COST)");
  console.log("========================================");

  const tolerances = ["MAX_RELIABILITY", "BALANCED", "LOWEST_COST"];
  const results: ComputedMetrics[] = [];
  const wethVolume: number[] = [];

  for (const tol of tolerances) {
    const config = { ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 25, providerGrowthRate: 0.0 };
    const world = runSim(config, (w) => {
      // Force all users to the target risk tolerance
      for (const u of w.users.values()) {
        u.riskTolerance = tol;
      }
      // Add attractive WETH corridor offers (USD→WETH→EUR)
      const activeProviders = [...w.providers.values()].filter(p => p.status === "ACTIVE");
      const weth = [...w.assets.values()].find(a => a.symbol === "WETH");
      if (!weth || activeProviders.length < 2) return;
      const p1 = activeProviders[0];
      const p2 = activeProviders[1];

      // USD → WETH (low fee, high incentive)
      w.offers.set("weth_hop1", {
        id: "weth_hop1", providerId: p1.id,
        capability: "FIAT_IN", sourceAsset: "USD", destinationAsset: "WETH",
        sourceCountry: "US", destinationCountry: "GLOBAL",
        rate: 1 / 2500, feeBps: 5, minimumAmount: 10, maximumAmount: 1000000,
        availableCapacity: 100000, reservedCapacity: 0,
        settlementAssetId: weth.id, channelType: "AUTOMATIC",
        expectedExecutionSeconds: 15, incentiveBps: 100, active: true, version: 1,
        settlementDurationSteps: 1,
      });
      // WETH → EUR (low fee, high incentive)
      w.offers.set("weth_hop2", {
        id: "weth_hop2", providerId: p2.id,
        capability: "FIAT_IN", sourceAsset: "WETH", destinationAsset: "EUR",
        sourceCountry: "GLOBAL", destinationCountry: "EU",
        rate: 2300, feeBps: 8, minimumAmount: 0.001, maximumAmount: 1000,
        availableCapacity: 100000 * 2500, reservedCapacity: 0,
        settlementAssetId: weth.id, channelType: "AUTOMATIC",
        expectedExecutionSeconds: 20, incentiveBps: 100, active: true, version: 1,
        settlementDurationSteps: 1,
      });
    });
    results.push(computeMetrics(world));

    // Track WETH provider volume
    let wVol = 0;
    for (const offer of world.offers.values()) {
      if (!offer.active) continue;
      if (offer.destinationAsset === "WETH" || offer.sourceAsset === "WETH") {
        const p = world.providers.get(offer.providerId);
        if (p) wVol += p.totalVolume;
      }
    }
    wethVolume.push(wVol);
  }

  printTable("Volatile Settlement Assets — Risk Tolerance Comparison",
    ["Metric", "MAX_RELIABILITY", "BALANCED", "LOWEST_COST"],
    [
      ["Avg user cost (bps)", ...results.map(r => r.avgCostBps.toFixed(1))],
      ["Completion rate (%)", ...results.map(r => r.completionRate.toFixed(1))],
      ["Total volume ($)", ...results.map(r => fmt(r.totalVolume, 0))],
      ["WETH-related volume ($)", ...wethVolume.map(v => fmt(v, 0))],
      ["Median return (%/yr)", ...results.map(r => r.medianRiskAdjustedReturn.toFixed(1))],
      ["HHI", ...results.map(r => r.hhi.toFixed(3))],
      ["Equilibrium", ...results.map(r => r.equilibrium)],
    ]);

  // WETH risk analysis
  console.log("\n**WETH Risk Analysis:**");
  console.log("- WETH settlement-asset risk ≈ 0.61 (base 0.35 + volatility 0.18 + liquidity 0.08)");
  console.log("- MAX_RELIABILITY ceiling: 0.25 → WETH **rejected** (0.61 > 0.25)");
  console.log("- BALANCED ceiling: 0.50 → WETH **rejected** (0.61 > 0.50)");
  console.log("- LOWEST_COST ceiling: 0.80 → WETH **passes** (0.61 < 0.80)");
  console.log("- Only LOWEST_COST users should route through WETH.");
}

// ---- Experiment 5: Patient Execution ----

function experiment5_patientExecution() {
  console.log("\n\n========================================");
  console.log("  EXPERIMENT 5: PATIENT EXECUTION");
  console.log("  (NOW vs WAIT_FOR_BETTER vs Mixed 50/50)");
  console.log("========================================");

  const policies = [
    { name: "NOW (100%)", config: { now: 1.0, waitForBetter: 0.0 } },
    { name: "WAIT (100%)", config: { now: 0.0, waitForBetter: 1.0 } },
    { name: "Mixed (50/50)", config: { now: 0.5, waitForBetter: 0.5 } },
    { name: "Mixed (70/30)", config: { now: 0.7, waitForBetter: 0.3 } },
  ];
  const results: ComputedMetrics[] = [];
  const avgWaits: number[] = [];

  for (const p of policies) {
    const config = { ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 25, providerGrowthRate: 0.0, policyDistribution: p.config };
    const world = runSimulation(config);
    const m = computeMetrics(world);
    results.push(m);
    avgWaits.push(m.avgCostBps);  // placeholder
    avgWaits[avgWaits.length - 1] = world.metricsHistory[world.metricsHistory.length - 1].avgWaitSteps;
  }

  printTable("Patient Execution — Policy Comparison",
    ["Metric", "NOW 100%", "WAIT 100%", "50/50", "70/30"],
    [
      ["Avg user cost (bps)", ...results.map(r => r.avgCostBps.toFixed(1))],
      ["Avg wait (steps)", ...avgWaits.map(w => w.toFixed(1))],
      ["P95 execution (steps)", ...results.map(r => r.p95ExecutionSteps.toString())],
      ["Completion rate (%)", ...results.map(r => r.completionRate.toFixed(1))],
      ["Expired intents", ...results.map(r => {
        const world = runSimulation({ ...createDefaultConfig(), seed: 42, totalSteps: 100, initialProviders: 25, providerGrowthRate: 0.0,
          policyDistribution: policies[results.indexOf(r)].config });
        return world.metricsHistory[world.metricsHistory.length - 1].expiredIntents.toString();
      })],
      ["Median return (%/yr)", ...results.map(r => r.medianRiskAdjustedReturn.toFixed(1))],
      ["User surplus ($)", ...results.map(r => fmt(r.userSurplus, 0))],
      ["Equilibrium", ...results.map(r => r.equilibrium)],
    ]);

  // Savings comparison
  const nowCost = results[0].avgCostBps;
  const waitCost = results[1].avgCostBps;
  const savings = nowCost - waitCost;
  const savingsPct = nowCost > 0 ? (savings / nowCost * 100).toFixed(1) : "0";

  console.log(`\n**Patient Execution Savings:**`);
  console.log(`- NOW avg cost: ${nowCost.toFixed(1)} bps`);
  console.log(`- WAIT avg cost: ${waitCost.toFixed(1)} bps`);
  console.log(`- Savings: ${savings.toFixed(1)} bps (${savingsPct}%)`);
  console.log(`- Trade-off: WAIT users wait ${avgWaits[1].toFixed(1)} steps vs ${avgWaits[0].toFixed(1)} steps for NOW`);
}

// ---- Main ----

function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   dRamp Simulator — Strategic Experiment Results        ║");
  console.log("║   Using canonical shared economics (Prompt 4.2)          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  experiment1_providerDensity();
  experiment2_coldStart();
  experiment3_stablecoinBootstrap();
  experiment4_volatileAssets();
  experiment5_patientExecution();

  console.log("\n\n========================================");
  console.log("  ALL EXPERIMENTS COMPLETE");
  console.log("========================================");
}

main();
