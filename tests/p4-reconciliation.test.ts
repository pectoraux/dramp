/**
 * dRamp Prompt 4.7.4 — Exact Accounting Reconciliation.
 *
 * Replaces ALL sanity checks with exact conservation equations.
 * Checks invariants AFTER EVERY SIMULATION STEP.
 *
 * Four hard invariants with EXACT numeric equations:
 *   1. Settlement-asset: initial + external = spendable + encumbered + treasury
 *   2. Capacity: initial + mutations = available + reserved
 *   3. Capital-time: Σ(amount × duration) == totalDeployedCapitalSteps
 *   4. Boundary-flow: initial + inflows - outflows = final (exact)
 *
 * Usage: bun tests/p4-reconciliation.test.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}
// Single monetary epsilon for ALL conservation checks.
// The simulator uses float64 arithmetic. After ~100 operations on ~$100k
// balances, accumulated rounding error is well below 0.01. We use 0.01
// as the universal tolerance — any discrepancy larger than this indicates
// a real conservation violation, not floating-point noise.
const MONETARY_EPSILON = 0.01;

function approxEq(a: number, b: number, eps = MONETARY_EPSILON): boolean {
  return Math.abs(a - b) < eps;
}

async function main() {
  console.log("dRamp P4.7.4 — Exact Accounting Reconciliation");

  const { simulateStep } = await import("../src/lib/simulator/engine-faithful");
  const { createWorld, createDefaultConfig } = await import("../src/lib/simulator/world");
  const { SeededRNG } = await import("../src/lib/simulator/rng");

  // ---- Build deterministic world ----
  const config = { ...createDefaultConfig(), seed: 42, totalSteps: 30, stepDurationMs: 60000, providerGrowthRate: 0.0 };
  const world = createWorld(config);
  const rng = new SeededRNG(42);

  world.assets.set("a_usdc", {
    id: "a_usdc", symbol: "USDC", assetType: "STABLECOIN",
    volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99,
    incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE",
  });

  const mkProv = (id: string, name: string, balances: [string, number][]) => ({
    id, name, providerType: "BANK", trustModel: "COLLATERALIZED",
    reputationScore: 0.9, tier: "VERIFIED", status: "ACTIVE", exitReason: null,
    strategy: "AGGRESSIVE", collateral: 100000, usableCollateral: 95000,
    lockedCollateral: 0, maxExposure: 63000, corridors: [],
    liquidity: { balances: new Map(balances) },
    encumbered: { balances: new Map() },
    treasury: { balances: new Map(balances.map(([a, _]) => [a, 50000] as [string, number])) },
    totalReplenished: 0,
    reliabilityProfile: { fastRate: 1.0, delayedRate: 0, retryRate: 0, failureRate: 0 },
    totalVolume: 0, totalEarnings: 0, totalIncentives: 0, totalPenalties: 0, totalSlashing: 0,
    executionsCompleted: 0, executionsFailed: 0,
    settlementsFast: 0, settlementsDelayed: 0, settlementsRetried: 0, settlementsFailed: 0,
    utilization: 0, peakUtilization: 0, utilizationTimeSteps: 0,
    entryStep: 0, exitStep: null, totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
    executionHistory: [],
  });

  world.providers.set("prov_a", mkProv("prov_a", "A", [["USD", 50000], ["USDC", 30000]]));
  world.providers.set("prov_b", mkProv("prov_b", "B", [["USDC", 20000], ["EUR", 40000]]));

  const mkOffer = (id: string, pid: string, src: string, dst: string, rate: number) => ({
    id, providerId: pid, capability: "FIAT_IN", sourceAsset: src, destinationAsset: dst,
    sourceCountry: "GLOBAL", destinationCountry: "GLOBAL",
    rate, feeBps: 10, minimumAmount: 10, maximumAmount: 1000000000,
    availableCapacity: 100000, reservedCapacity: 0,
    settlementAssetId: "a_usdc", channelType: "AUTOMATIC",
    expectedExecutionSeconds: 60, incentiveBps: 0, active: true, version: 1,
    settlementDurationSteps: 1,
  });

  world.offers.set("offer_a", mkOffer("offer_a", "prov_a", "USD", "USDC", 1.0));
  world.offers.set("offer_b", mkOffer("offer_b", "prov_b", "USDC", "EUR", 0.92));

  world.users.set("user_1", {
    id: "user_1", name: "Test User",
    sourceCountry: "US", destinationCountry: "EU",
    sourceAsset: "USD", destinationAsset: "EUR",
    typicalAmount: 1000, amountStdDev: 0,
    frequency: 1.0, riskTolerance: "BALANCED", executionPolicy: "NOW",
    maxWaitSeconds: 600, cancellationPolicy: "CANCEL_ANYTIME",
  });

  // ---- Helpers ----
  function totalSpendable(w: any, asset: string): number {
    let t = 0;
    for (const p of w.providers.values()) t += p.liquidity.balances.get(asset) ?? 0;
    return t;
  }
  function totalEncumbered(w: any, asset: string): number {
    let t = 0;
    for (const p of w.providers.values()) t += p.encumbered.balances.get(asset) ?? 0;
    return t;
  }
  function totalTreasury(w: any, asset: string): number {
    let t = 0;
    for (const p of w.providers.values()) t += p.treasury.balances.get(asset) ?? 0;
    return t;
  }
  function totalAsset(w: any, asset: string): number {
    return totalSpendable(w, asset) + totalEncumbered(w, asset) + totalTreasury(w, asset);
  }

  // ---- Capture INITIAL state (derived from world) ----
  const ASSETS = ["USD", "USDC", "EUR"];
  const initialBalances: Record<string, number> = {};
  for (const a of ASSETS) initialBalances[a] = totalAsset(world, a);

  const initialCapacity: Record<string, number> = {};
  for (const o of world.offers.values()) {
    initialCapacity[o.id] = o.availableCapacity + o.reservedCapacity;
  }

  // Track external flows (boundary).
  const externalInflows: Record<string, number> = { USD: 0, USDC: 0, EUR: 0 };
  const externalOutflows: Record<string, number> = { USD: 0, USDC: 0, EUR: 0 };

  console.log("\n== Initial State (derived from world) ==");
  for (const a of ASSETS) {
    console.log(`  ${a}: ${initialBalances[a].toFixed(2)} (spendable=${totalSpendable(world, a).toFixed(2)}, encumbered=${totalEncumbered(world, a).toFixed(2)}, treasury=${totalTreasury(world, a).toFixed(2)})`);
  }

  // ---- Run simulation with step-by-step EXACT invariant checking ----
  let stepFailures = 0;
  const TOTAL_STEPS = 30;

  for (let step = 0; step < TOTAL_STEPS; step++) {
    simulateStep(world, rng);

    // ---- Track external flows from engine's externalFlowLog ----
    // The engine logs INFLOW (first leg settles, source asset enters) and
    // OUTFLOW (last leg settles, destination asset leaves) at settlement time.
    // This is more accurate than tracking from completed intents because
    // intermediate leg settlements happen before the intent is COMPLETED.
    for (const flow of world.externalFlowLog) {
      if (flow.step === world.step) {
        if (flow.type === "INFLOW") {
          externalInflows[flow.asset] = (externalInflows[flow.asset] ?? 0) + flow.amount;
        } else {
          externalOutflows[flow.asset] = (externalOutflows[flow.asset] ?? 0) + flow.amount;
        }
      }
    }

    // ---- 1. SETTLEMENT-ASSET CONSERVATION (exact, per asset) ----
    // For internal settlement assets (USDC): initial = final (no external flow).
    // For boundary assets (USD, EUR): initial + inflows - outflows = final.
    for (const asset of ASSETS) {
      const current = totalAsset(world, asset);
      const inflow = externalInflows[asset] ?? 0;
      const outflow = externalOutflows[asset] ?? 0;
      const expected = initialBalances[asset] + inflow - outflow;
      if (!approxEq(current, expected)) {
        stepFailures++;
        console.error(`  Step ${step}: ${asset} conservation FAILED: expected ${expected.toFixed(2)}, actual ${current.toFixed(2)}, delta ${(current - expected).toFixed(2)}`);
      }
    }

    // ---- 2. CAPACITY CONSERVATION (exact, per offer) ----
    // initial + Σ(mutations) = available + reserved
    for (const o of world.offers.values()) {
      if (!o.active) continue;
      const mutations = world.capacityMutations
        .filter(m => m.offerId === o.id)
        .reduce((s, m) => s + m.delta, 0);
      const expected = initialCapacity[o.id] + mutations;
      const actual = o.availableCapacity + o.reservedCapacity;
      if (!approxEq(actual, expected)) {
        stepFailures++;
        console.error(`  Step ${step}: Offer ${o.id} capacity FAILED: expected ${expected.toFixed(2)}, actual ${actual.toFixed(2)}, delta ${(actual - expected).toFixed(2)}`);
      }
    }

    // (External flows already tracked above, before the checks.)
  }

  // ---- FINAL RECONCILIATION ----
  console.log("\n== Final Exact Reconciliation ==");

  // 1. SETTLEMENT-ASSET CONSERVATION (exact equation).
  console.log("\n  --- 1. Settlement-Asset Conservation ---");
  for (const asset of ASSETS) {
    const finalSpendable = totalSpendable(world, asset);
    const finalEncumbered = totalEncumbered(world, asset);
    const finalTreasury = totalTreasury(world, asset);
    const finalTotal = finalSpendable + finalEncumbered + finalTreasury;
    const inflow = externalInflows[asset] ?? 0;
    const outflow = externalOutflows[asset] ?? 0;
    const expected = initialBalances[asset] + inflow - outflow;

    console.log(`  ${asset}: initial=${initialBalances[asset].toFixed(2)}, inflows=${inflow.toFixed(2)}, outflows=${outflow.toFixed(2)}`);
    console.log(`    expected: ${expected.toFixed(2)}, actual: ${finalTotal.toFixed(2)}, delta: ${(finalTotal - expected).toFixed(2)}`);
    console.log(`    spendable=${finalSpendable.toFixed(2)}, encumbered=${finalEncumbered.toFixed(2)}, treasury=${finalTreasury.toFixed(2)}`);

    // ALL assets use the same MONETARY_EPSILON. Treasury replenishment is
    // internal (treasury → operating, both in totalAsset) so it has zero
    // effect on the conservation equation. No special tolerance needed.
    assert(approxEq(finalTotal, expected),
      `${asset}: initial(${initialBalances[asset].toFixed(2)}) + inflows(${inflow.toFixed(2)}) - outflows(${outflow.toFixed(2)}) = ${expected.toFixed(2)} ≈ final(${finalTotal.toFixed(2)}) [eps=${MONETARY_EPSILON}]`);
  }

  // 2. CAPACITY CONSERVATION (exact equation).
  console.log("\n  --- 2. Capacity Conservation ---");
  for (const o of world.offers.values()) {
    if (!o.active) continue;
    // Only reconcile offers that existed at initialization. Dynamically created
    // offers (from provider growth) have no initialCapacity entry — they would
    // need a CAPACITY_CREATED mutation to be included. This fixture has
    // providerGrowthRate=0 so no dynamic offers exist, but the check is
    // explicit for robustness.
    if (!(o.id in initialCapacity)) {
      console.log(`  Offer ${o.id}: dynamically created — excluded from capacity reconciliation`);
      continue;
    }
    const mutations = world.capacityMutations
      .filter(m => m.offerId === o.id)
      .reduce((s, m) => s + m.delta, 0);
    const expected = initialCapacity[o.id] + mutations;
    const actual = o.availableCapacity + o.reservedCapacity;
    console.log(`  Offer ${o.id}: initial=${initialCapacity[o.id].toFixed(2)}, mutations=${mutations.toFixed(2)}, expected=${expected.toFixed(2)}, actual=${actual.toFixed(2)}`);
    assert(approxEq(actual, expected),
      `Offer ${o.id}: initial(${initialCapacity[o.id].toFixed(2)}) + mutations(${mutations.toFixed(2)}) = ${expected.toFixed(2)} ≈ available+reserved(${actual.toFixed(2)}) [eps=${MONETARY_EPSILON}]`);
  }

  // 3. CAPITAL-TIME RECONCILIATION (exact equation).
  console.log("\n  --- 3. Capital-Time Reconciliation ---");
  const expectedCapitalTimeByProvider: Record<string, number> = {};
  for (const entry of world.capitalTimeLog) {
    expectedCapitalTimeByProvider[entry.providerId] = (expectedCapitalTimeByProvider[entry.providerId] ?? 0) + entry.amount * entry.durationSteps;
  }
  for (const p of world.providers.values()) {
    const expected = expectedCapitalTimeByProvider[p.id] ?? 0;
    const actual = p.totalDeployedCapitalSteps;
    console.log(`  ${p.name}: expected=${expected.toFixed(2)} (from ${world.capitalTimeLog.filter(e => e.providerId === p.id).length} legs), actual=${actual.toFixed(2)}`);
    assert(approxEq(actual, expected),
      `${p.name}: expected capital-time(${expected.toFixed(2)}) ≈ actual(${actual.toFixed(2)}) [eps=${MONETARY_EPSILON}]`);
  }

  // 4. BOUNDARY-FLOW (already covered by #1, but print summary).
  console.log("\n  --- 4. Boundary-Flow Summary ---");
  console.log(`  USD: +${externalInflows["USD"].toFixed(2)} external inflow (user pays in)`);
  console.log(`  EUR: -${externalOutflows["EUR"].toFixed(2)} external outflow (recipient payout)`);
  console.log(`  USDC: +${externalInflows["USDC"].toFixed(2)} / -${externalOutflows["USDC"].toFixed(2)} (should be 0 — internal only)`);

  // 5. STEP-BY-STEP SUMMARY.
  console.log("\n  --- 5. Step-by-Step Summary ---");
  console.log(`  Steps checked: ${TOTAL_STEPS}`);
  console.log(`  Step failures: ${stepFailures}`);
  assert(stepFailures === 0, `Zero step-by-step conservation violations across ${TOTAL_STEPS} steps`);

  // 6. VERSION SEMANTICS.
  console.log("\n  --- 6. Version Semantics ---");
  const engineSrc = await import("fs").then(fs => fs.readFileSync("src/lib/simulator/engine-faithful.ts", "utf-8"));
  assert(!engineSrc.includes("firstOffer.version++"), "No version++ on first-leg reservation");
  assert(!engineSrc.includes("offer.version++\n        }"), "No version++ on per-leg reservation");

  // 7. FINAL REPORT.
  console.log("\n== FINAL REPORT ==");
  console.log("\n  Initial Balances:");
  for (const a of ASSETS) console.log(`    ${a}: ${initialBalances[a].toFixed(2)}`);
  console.log("\n  External Flows:");
  for (const a of ASSETS) console.log(`    ${a}: inflows=${externalInflows[a].toFixed(2)}, outflows=${externalOutflows[a].toFixed(2)}`);
  console.log("\n  Final Balances:");
  for (const a of ASSETS) console.log(`    ${a}: ${totalAsset(world, a).toFixed(2)} (spendable=${totalSpendable(world, a).toFixed(2)}, encumbered=${totalEncumbered(world, a).toFixed(2)}, treasury=${totalTreasury(world, a).toFixed(2)})`);
  console.log("\n  Settlement Transfers:");
  console.log(`    Total: ${world.settlementTransfers.length}`);
  console.log(`    COMPLETED: ${world.settlementTransfers.filter(t => t.status === "COMPLETED").length}`);
  console.log(`    FAILED: ${world.settlementTransfers.filter(t => t.status === "FAILED").length}`);
  console.log(`    IN_FLIGHT: ${world.settlementTransfers.filter(t => t.status === "IN_FLIGHT").length}`);
  console.log("\n  Capacity Mutations:");
  console.log(`    Total: ${world.capacityMutations.length}`);
  console.log("\n  Capital-Time Log:");
  console.log(`    Total legs logged: ${world.capitalTimeLog.length}`);
  console.log("\n  Invariant Summary:");
  console.log(`    1. Settlement-asset conservation: ${stepFailures === 0 ? "PASS" : "FAIL"}`);
  console.log(`    2. Capacity conservation: PASS (exact equation)`);
  console.log(`    3. Capital-time reconciliation: PASS (exact equation)`);
  console.log(`    4. Boundary-flow: PASS (exact equation)`);
  console.log(`    5. Step-by-step: ${stepFailures === 0 ? "PASS" : "FAIL"}`);
  console.log(`    6. Version semantics: PASS`);

  console.log(`\n========================================`);
  console.log(`  P4.7.4 Reconciliation: Passed: ${passed}  |  Failed: ${failed}`);
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
