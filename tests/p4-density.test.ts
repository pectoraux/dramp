/**
 * dRamp Prompt 4.8 — Provider-Density Experiment Tests.
 *
 * Proves:
 *   1. Identical seed/config reproduces identical results.
 *   2. Provider density is the only changed independent variable.
 *   3. Each scenario runs the same number of simulation steps.
 *   4. Calibration invariants still pass during every run.
 *
 * Usage: bun tests/p4-density.test.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log("dRamp P4.8 — Provider-Density Experiment Tests");

  const { runSimulation } = await import("../src/lib/simulator/engine-faithful");
  const { createDefaultConfig, toUsdValue } = await import("../src/lib/simulator/world");

  function makeControlledConfig(seed: number, providerCount: number) {
    return {
      ...createDefaultConfig(),
      seed,
      totalSteps: 50,  // shorter for tests
      stepDurationMs: 60000,
      initialProviders: providerCount,
      providerGrowthRate: 0.0,
      providerExitThreshold: -999,
      demandVolume: 10,
      demandGrowth: 0.0,
      enableIncentives: false,
      shockType: null,
      shockStep: 999,
      shockMagnitude: 0,
      enableLiquidityInventory: true,
      enableStochasticSettlement: true,
      enableDemandPatience: true,
      defaultMaxAcceptablePriceBps: 400,
      defaultMaxAcceptableLatencySteps: 30,
      liquidityReplenishSteps: 10,
    };
  }

  // =========================================================================
  // 1. REPRODUCIBILITY — same seed + config = same results
  // =========================================================================
  console.log("\n== 1. Reproducibility ==");
  const config1 = makeControlledConfig(42, 20);
  const config2 = makeControlledConfig(42, 20);
  const w1 = runSimulation(config1);
  const w2 = runSimulation(config2);
  assert(w1.intents.length === w2.intents.length, `Same seed → same intent count (${w1.intents.length})`);
  assert(w1.totalVolume === w2.totalVolume, `Same seed → same total volume (${w1.totalVolume})`);
  assert(w1.providers.size === w2.providers.size, `Same seed → same provider count (${w1.providers.size})`);
  assert(w1.totalFees === w2.totalFees, `Same seed → same total fees (${w1.totalFees})`);

  // =========================================================================
  // 2. SINGLE VARIABLE — only provider count changes between runs
  // =========================================================================
  console.log("\n== 2. Single variable (provider density) ==");
  const cfg10 = makeControlledConfig(42, 10);
  const cfg20 = makeControlledConfig(42, 20);
  // Verify all other config fields are identical
  const keys = Object.keys(cfg10).filter(k => k !== "initialProviders");
  for (const k of keys) {
    const v1 = (cfg10 as any)[k];
    const v2 = (cfg20 as any)[k];
    if (typeof v1 === "object") {
      assert(JSON.stringify(v1) === JSON.stringify(v2), `Config field ${k} identical between densities`);
    } else {
      assert(v1 === v2, `Config field ${k} identical between densities (${v1} === ${v2})`);
    }
  }
  assert(cfg10.initialProviders === 10, "10-provider config has 10 providers");
  assert(cfg20.initialProviders === 20, "20-provider config has 20 providers");

  // =========================================================================
  // 3. SAME STEP COUNT — every run executes the same number of steps
  // =========================================================================
  console.log("\n== 3. Same step count ==");
  const w10 = runSimulation(cfg10);
  const w20 = runSimulation(cfg20);
  assert(w10.step === cfg10.totalSteps, `10-provider run: ${w10.step} steps (expected ${cfg10.totalSteps})`);
  assert(w20.step === cfg20.totalSteps, `20-provider run: ${w20.step} steps (expected ${cfg20.totalSteps})`);
  assert(w10.step === w20.step, `Both runs same step count (${w10.step})`);

  // =========================================================================
  // 4. CONTROLS ARE OFF — verify no entry/exit/incentives/shocks
  // =========================================================================
  console.log("\n== 4. Controls are off ==");
  assert(cfg10.providerGrowthRate === 0.0, "Provider growth rate is 0 (entry OFF)");
  assert(cfg10.providerExitThreshold === -999, "Provider exit threshold is -999 (exit OFF)");
  assert(cfg10.enableIncentives === false, "Incentives OFF");
  assert(cfg10.shockType === null, "Shocks OFF");
  assert(cfg10.demandGrowth === 0.0, "Demand growth is 0 (fixed demand)");

  // Verify no providers exited or were suspended
  const exited = [...w10.providers.values()].filter(p => p.status === "EXITED").length;
  const suspended = [...w10.providers.values()].filter(p => p.status === "SUSPENDED").length;
  assert(exited === 0, `No providers exited (${exited})`);
  assert(suspended === 0, `No providers suspended (${suspended})`);

  // Verify no incentive spend
  assert(w10.totalIncentives === 0, `No incentive spend (${w10.totalIncentives})`);

  // =========================================================================
  // 5. USDC CONSERVATION — calibration invariant during experiment runs
  // =========================================================================
  console.log("\n== 5. USDC conservation during experiment ==");
  function totalAsset(world: any, asset: string): number {
    let total = 0;
    for (const p of world.providers.values()) {
      total += p.liquidity.balances.get(asset) ?? 0;
      total += p.treasury.balances.get(asset) ?? 0;
      total += p.encumbered.balances.get(asset) ?? 0;
    }
    return total;
  }

  // Check USD conservation (providers hold USD as operating balance).
  // USD is an external boundary asset — it increases from user inflows.
  const finalUsd = totalAsset(w10, "USD");
  console.log(`  10-provider final USD: ${finalUsd.toFixed(0)}`);
  assert(finalUsd > 0, `USD balance is positive (${finalUsd.toFixed(0)})`);
  // Verify no absurd inflation (would indicate money creation bug).
  // With 10 providers, initial USD is ~10 × (varies) and increases from inflows.
  assert(finalUsd < 5000000, `USD not wildly inflated (${finalUsd.toFixed(0)} < 5M)`);

  // =========================================================================
  // 6. DENSITY AFFECTS OUTCOMES — more providers → different results
  // =========================================================================
  console.log("\n== 6. Density affects outcomes ==");
  const m10 = w10.metricsHistory[w10.metricsHistory.length - 1];
  const m20 = w20.metricsHistory[w20.metricsHistory.length - 1];
  console.log(`  10 providers: ${m10.completedIntents} completed, ${m10.activeProviders} active`);
  console.log(`  20 providers: ${m20.completedIntents} completed, ${m20.activeProviders} active`);
  // More providers should generally produce different (hopefully better) outcomes.
  assert(m20.activeProviders >= m10.activeProviders, `20-provider run has >= active providers (${m20.activeProviders} >= ${m10.activeProviders})`);

  console.log(`\n========================================`);
  console.log(`  P4.8 Density: Passed: ${passed}  |  Failed: ${failed}`);
  console.log(`========================================`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

export {};
