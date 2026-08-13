/**
 * dRamp Prompt 4.7.2 — Real Multi-Hop Conservation Fixture.
 *
 * Creates a DETERMINISTIC world where a real USD→USDC→EUR multi-hop execution
 * is GUARANTEED to occur, then asserts NUMERIC balance conservation.
 *
 * This test FAILS if no actual multi-hop transfer occurs.
 * It does NOT rely on source-code inspection.
 *
 * Usage: bun tests/p4-conservation.test.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}
function approxEq(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

async function main() {
  console.log("dRamp P4.7.2 — Real Multi-Hop Conservation Fixture");

  const { simulateStep } = await import("../src/lib/simulator/engine-faithful");
  const { createWorld, createDefaultConfig } = await import("../src/lib/simulator/world");
  const { SeededRNG } = await import("../src/lib/simulator/rng");
  const { toUsdValue } = await import("../src/lib/simulator/world");

  // ---- Helper: sum all provider balances (operating + treasury) for an asset ----
  function totalNetworkBalance(world: any, asset: string): number {
    let total = 0;
    for (const p of world.providers.values()) {
      total += p.liquidity.balances.get(asset) ?? 0;
      total += p.treasury.balances.get(asset) ?? 0;
    }
    return total;
  }

  // ---- Build a deterministic world with USD→USDC→EUR route ----
  function buildMultiHopWorld() {
    const config = { ...createDefaultConfig(), seed: 42, totalSteps: 20, stepDurationMs: 60000 };
    const world = createWorld(config);
    const rng = new SeededRNG(42);

    // Create USDC settlement asset.
    world.assets.set("asset_usdc", {
      id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN",
      volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99,
      incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE",
    });

    // Create Provider A: USD→USDC (leg 1)
    const providerA = {
      id: "prov_a", name: "Provider A", providerType: "BANK", trustModel: "COLLATERALIZED",
      reputationScore: 0.9, tier: "VERIFIED", status: "ACTIVE", exitReason: null,
      strategy: "AGGRESSIVE", collateral: 100000, usableCollateral: 95000,
      lockedCollateral: 0, maxExposure: 63000, corridors: [],
      liquidity: { balances: new Map([["USD", 50000], ["USDC", 30000]]) },
      treasury: { balances: new Map([["USD", 100000], ["USDC", 50000]]) },
      totalReplenished: 0,
      reliabilityProfile: { fastRate: 1.0, delayedRate: 0, retryRate: 0, failureRate: 0 },
      totalVolume: 0, totalEarnings: 0, totalIncentives: 0, totalPenalties: 0, totalSlashing: 0,
      executionsCompleted: 0, executionsFailed: 0,
      settlementsFast: 0, settlementsDelayed: 0, settlementsRetried: 0, settlementsFailed: 0,
      utilization: 0, peakUtilization: 0, utilizationTimeSteps: 0,
      entryStep: 0, exitStep: null,
      totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
      executionHistory: [],
    };
    world.providers.set(providerA.id, providerA);

    // Create Provider B: USDC→EUR (leg 2)
    const providerB = {
      id: "prov_b", name: "Provider B", providerType: "BANK", trustModel: "COLLATERALIZED",
      reputationScore: 0.85, tier: "VERIFIED", status: "ACTIVE", exitReason: null,
      strategy: "AGGRESSIVE", collateral: 100000, usableCollateral: 95000,
      lockedCollateral: 0, maxExposure: 63000, corridors: [],
      liquidity: { balances: new Map([["USDC", 20000], ["EUR", 40000]]) },
      treasury: { balances: new Map([["USDC", 50000], ["EUR", 80000]]) },
      totalReplenished: 0,
      reliabilityProfile: { fastRate: 1.0, delayedRate: 0, retryRate: 0, failureRate: 0 },
      totalVolume: 0, totalEarnings: 0, totalIncentives: 0, totalPenalties: 0, totalSlashing: 0,
      executionsCompleted: 0, executionsFailed: 0,
      settlementsFast: 0, settlementsDelayed: 0, settlementsRetried: 0, settlementsFailed: 0,
      utilization: 0, peakUtilization: 0, utilizationTimeSteps: 0,
      entryStep: 0, exitStep: null,
      totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
      executionHistory: [],
    };
    world.providers.set(providerB.id, providerB);

    // Create Offer A: USD → USDC (Provider A)
    world.offers.set("offer_a", {
      id: "offer_a", providerId: "prov_a",
      capability: "FIAT_IN", sourceAsset: "USD", destinationAsset: "USDC",
      sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: 1.0, feeBps: 10, minimumAmount: 10, maximumAmount: 1000000,
      availableCapacity: 100000, reservedCapacity: 0,
      settlementAssetId: "asset_usdc", channelType: "AUTOMATIC",
      expectedExecutionSeconds: 60, incentiveBps: 0, active: true, version: 1,
      settlementDurationSteps: 1,
    });

    // Create Offer B: USDC → EUR (Provider B)
    world.offers.set("offer_b", {
      id: "offer_b", providerId: "prov_b",
      capability: "FIAT_IN", sourceAsset: "USDC", destinationAsset: "EUR",
      sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: 0.92, feeBps: 15, minimumAmount: 10, maximumAmount: 1000000,
      availableCapacity: 100000, reservedCapacity: 0,
      settlementAssetId: "asset_usdc", channelType: "AUTOMATIC",
      expectedExecutionSeconds: 60, incentiveBps: 0, active: true, version: 1,
      settlementDurationSteps: 1,
    });

    // Create a user that wants USD → EUR.
    world.users.set("user_1", {
      id: "user_1", name: "Test User",
      sourceCountry: "US", destinationCountry: "EU",
      sourceAsset: "USD", destinationAsset: "EUR",
      typicalAmount: 1000, amountStdDev: 0,
      frequency: 1.0, riskTolerance: "BALANCED", executionPolicy: "NOW",
      maxWaitSeconds: 600, cancellationPolicy: "CANCEL_ANYTIME",
    });

    // Capture initial balances.
    const initialUsdc = totalNetworkBalance(world, "USDC");
    const initialEur = totalNetworkBalance(world, "EUR");
    const initialUsd = totalNetworkBalance(world, "USD");

    return { world, rng, initialUsdc, initialEur, initialUsd };
  }

  // =========================================================================
  // 1. GUARANTEED MULTI-HOP EXECUTION — USD → USDC → EUR
  // =========================================================================
  console.log("\n== 1. Guaranteed USD→USDC→EUR multi-hop execution ==");

  const { world: w1, rng: rng1, initialUsdc: initUsdc1, initialEur: initEur1, initialUsd: initUsd1 } = buildMultiHopWorld();

  // Run enough steps for the multi-hop to complete (leg 1: 1 step, leg 2: 1 step = 2+ steps).
  for (let i = 0; i < 10; i++) {
    simulateStep(w1, rng1);
  }

  // HARD ASSERTION: at least one settlement transfer must exist.
  const transfers1 = w1.settlementTransfers.filter(t => t.status === "COMPLETED");
  assert(transfers1.length >= 1,
    `At least 1 settlement transfer exists (got ${transfers1.length}) — REAL multi-hop occurred`);

  if (transfers1.length > 0) {
    const transfer = transfers1[0];
    console.log(`  Transfer: ${transfer.amount.toFixed(2)} ${transfer.asset} from ${transfer.fromProviderId} to ${transfer.toProviderId}`);
    assert(transfer.asset === "USDC", `Transfer asset is USDC (${transfer.asset})`);
    assert(transfer.fromProviderId === "prov_a", `Transfer from Provider A (${transfer.fromProviderId})`);
    assert(transfer.toProviderId === "prov_b", `Transfer to Provider B (${transfer.toProviderId})`);
  }

  // Check completed intents.
  const completed1 = w1.intents.filter(i => i.status === "COMPLETED");
  assert(completed1.length >= 1, `At least 1 completed intent (${completed1.length})`);

  // =========================================================================
  // 2. NUMERIC USDC CONSERVATION — A debit == B credit
  // =========================================================================
  console.log("\n== 2. Numeric USDC conservation ==");

  const finalUsdc1 = totalNetworkBalance(w1, "USDC");
  const providerAFinalUsdc = (w1.providers.get("prov_a")!.liquidity.balances.get("USDC") ?? 0)
                           + (w1.providers.get("prov_a")!.treasury.balances.get("USDC") ?? 0);
  const providerBFinalUsdc = (w1.providers.get("prov_b")!.liquidity.balances.get("USDC") ?? 0)
                           + (w1.providers.get("prov_b")!.treasury.balances.get("USDC") ?? 0);

  console.log(`  Initial USDC: ${initUsdc1.toFixed(2)}`);
  console.log(`  Final USDC: ${finalUsdc1.toFixed(2)}`);
  console.log(`  Provider A USDC: ${providerAFinalUsdc.toFixed(2)}`);
  console.log(`  Provider B USDC: ${providerBFinalUsdc.toFixed(2)}`);

  // USDC is an internal settlement asset — total network balance must be CONSERVED.
  // No external USDC enters or leaves the network.
  assert(approxEq(finalUsdc1, initUsdc1),
    `USDC conserved: initial ${initUsdc1.toFixed(2)} == final ${finalUsdc1.toFixed(2)}`);

  // Provider A's USDC should have DECREASED (paid out to B).
  // Provider B's USDC should have stayed roughly the same (received from A, then paid out to EUR).
  // The key invariant: total USDC unchanged.

  // =========================================================================
  // 3. NUMERIC EUR CONSERVATION — external payout
  // =========================================================================
  console.log("\n== 3. Numeric EUR conservation ==");

  const finalEur1 = totalNetworkBalance(w1, "EUR");
  console.log(`  Initial EUR: ${initEur1.toFixed(2)}`);
  console.log(`  Final EUR: ${finalEur1.toFixed(2)}`);

  // EUR is the external payout — Provider B's EUR decreases (paid to recipient).
  // This is a boundary outflow, not internal conservation.
  assert(finalEur1 < initEur1,
    `EUR decreased (external payout): ${initEur1.toFixed(2)} → ${finalEur1.toFixed(2)}`);

  // =========================================================================
  // 4. NUMERIC USD CONSERVATION — external input
  // =========================================================================
  console.log("\n== 4. Numeric USD conservation ==");

  const finalUsd1 = totalNetworkBalance(w1, "USD");
  console.log(`  Initial USD: ${initUsd1.toFixed(2)}`);
  console.log(`  Final USD: ${finalUsd1.toFixed(2)}`);

  // USD is the external input — Provider A's USD increases (user paid in).
  // This is a boundary inflow.
  assert(finalUsd1 > initUsd1,
    `USD increased (external input): ${initUsd1.toFixed(2)} → ${finalUsd1.toFixed(2)}`);

  // =========================================================================
  // 5. MULTI-ASSET CONSERVATION — USD→USDC→EUR + USD→EURC→NGN (separate 2-hop)
  // =========================================================================
  console.log("\n== 5. Multi-asset conservation (two 2-hop routes) ==");

  // Build a world with two different settlement assets (USDC and EURC).
  const config3 = { ...createDefaultConfig(), seed: 99, totalSteps: 20, stepDurationMs: 60000 };
  const w3 = createWorld(config3);
  const rng3 = new SeededRNG(99);

  // Create USDC and EURC settlement assets.
  w3.assets.set("a_usdc", { id: "a_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" });
  w3.assets.set("a_eurc", { id: "a_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" });

  // 4 providers for 2 separate 2-hop routes.
  const mkProv = (id: string, name: string, balances: [string, number][]) => ({
    id, name, providerType: "BANK", trustModel: "COLLATERALIZED",
    reputationScore: 0.9, tier: "VERIFIED", status: "ACTIVE", exitReason: null,
    strategy: "AGGRESSIVE", collateral: 100000, usableCollateral: 95000,
    lockedCollateral: 0, maxExposure: 63000, corridors: [],
    liquidity: { balances: new Map(balances) },
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

  // Route 1: USD→USDC→EUR (providers p1, p2)
  w3.providers.set("p1", mkProv("p1", "P1", [["USD", 50000], ["USDC", 30000]]));
  w3.providers.set("p2", mkProv("p2", "P2", [["USDC", 20000], ["EUR", 40000]]));
  // Route 2: USD→EURC→NGN (providers p3, p4)
  w3.providers.set("p3", mkProv("p3", "P3", [["USD", 50000], ["EURC", 30000]]));
  w3.providers.set("p4", mkProv("p4", "P4", [["EURC", 20000], ["NGN", 50000000]]));

  const mkOffer = (id: string, pid: string, src: string, dst: string, rate: number, saId: string) => ({
    id, providerId: pid, capability: "FIAT_IN", sourceAsset: src, destinationAsset: dst,
    sourceCountry: "GLOBAL", destinationCountry: "GLOBAL",
    rate, feeBps: 10, minimumAmount: 10, maximumAmount: 1000000000,
    availableCapacity: 1000000, reservedCapacity: 0,
    settlementAssetId: saId, channelType: "AUTOMATIC",
    expectedExecutionSeconds: 60, incentiveBps: 0, active: true, version: 1,
    settlementDurationSteps: 1,
  });

  // Route 1 offers
  w3.offers.set("o1", mkOffer("o1", "p1", "USD", "USDC", 1.0, "a_usdc"));
  w3.offers.set("o2", mkOffer("o2", "p2", "USDC", "EUR", 0.92, "a_usdc"));
  // Route 2 offers
  w3.offers.set("o3", mkOffer("o3", "p3", "USD", "EURC", 0.92, "a_eurc"));
  w3.offers.set("o4", mkOffer("o4", "p4", "EURC", "NGN", 1500, "a_eurc"));

  // User 1 wants USD → EUR (route 1, USDC settlement).
  w3.users.set("u1", {
    id: "u1", name: "U1", sourceCountry: "US", destinationCountry: "EU",
    sourceAsset: "USD", destinationAsset: "EUR",
    typicalAmount: 1000, amountStdDev: 0, frequency: 1.0,
    riskTolerance: "BALANCED", executionPolicy: "NOW",
    maxWaitSeconds: 600, cancellationPolicy: "CANCEL_ANYTIME",
  });
  // User 2 wants USD → NGN (route 2, EURC settlement).
  w3.users.set("u2", {
    id: "u2", name: "U2", sourceCountry: "US", destinationCountry: "NG",
    sourceAsset: "USD", destinationAsset: "NGN",
    typicalAmount: 500, amountStdDev: 0, frequency: 1.0,
    riskTolerance: "BALANCED", executionPolicy: "NOW",
    maxWaitSeconds: 600, cancellationPolicy: "CANCEL_ANYTIME",
  });

  const initUsdc3 = totalNetworkBalance(w3, "USDC");
  const initEurc3 = totalNetworkBalance(w3, "EURC");

  for (let i = 0; i < 15; i++) {
    simulateStep(w3, rng3);
  }

  const transfers3 = w3.settlementTransfers.filter(t => t.status === "COMPLETED");
  const usdcTransfers = transfers3.filter(t => t.asset === "USDC");
  const eurcTransfers = transfers3.filter(t => t.asset === "EURC");
  assert(usdcTransfers.length >= 1, `USDC transfers exist (${usdcTransfers.length}) — route 1 executed`);
  assert(eurcTransfers.length >= 1, `EURC transfers exist (${eurcTransfers.length}) — route 2 executed`);

  const finalUsdc3 = totalNetworkBalance(w3, "USDC");
  const finalEurc3 = totalNetworkBalance(w3, "EURC");

  console.log(`  USDC: ${initUsdc3.toFixed(2)} → ${finalUsdc3.toFixed(2)} (${usdcTransfers.length} transfers)`);
  console.log(`  EURC: ${initEurc3.toFixed(2)} → ${finalEurc3.toFixed(2)} (${eurcTransfers.length} transfers)`);

  // Both internal settlement assets must be conserved independently.
  assert(approxEq(finalUsdc3, initUsdc3),
    `USDC conserved: ${initUsdc3.toFixed(2)} == ${finalUsdc3.toFixed(2)}`);
  assert(approxEq(finalEurc3, initEurc3),
    `EURC conserved: ${initEurc3.toFixed(2)} == ${finalEurc3.toFixed(2)}`);

  // =========================================================================
  // 6. FAILURE CONSERVATION — downstream failure doesn't create/destroy assets
  // =========================================================================
  console.log("\n== 6. Failure conservation ==");

  // Build a world where Provider B has a failure rate.
  const configF = { ...createDefaultConfig(), seed: 77, totalSteps: 30, stepDurationMs: 60000 };
  const wF = createWorld(configF);
  const rngF = new SeededRNG(77);

  wF.assets.set("a_usdc_f", { id: "a_usdc_f", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" });

  // Provider B has a 50% failure rate — will trigger downstream failures.
  wF.providers.set("pf_a", mkProv("pf_a", "PF-A", [["USD", 50000], ["USDC", 30000]]));
  const provBF = mkProv("pf_b", "PF-B", [["USDC", 20000], ["EUR", 40000]]);
  provBF.reliabilityProfile = { fastRate: 0.4, delayedRate: 0.1, retryRate: 0, failureRate: 0.5 };
  wF.providers.set("pf_b", provBF);

  wF.offers.set("of_a", mkOffer("of_a", "pf_a", "USD", "USDC", 1.0, "a_usdc_f"));
  wF.offers.set("of_b", mkOffer("of_b", "pf_b", "USDC", "EUR", 0.92, "a_usdc_f"));

  wF.users.set("uf_1", {
    id: "uf_1", name: "UF", sourceCountry: "US", destinationCountry: "EU",
    sourceAsset: "USD", destinationAsset: "EUR",
    typicalAmount: 1000, amountStdDev: 0, frequency: 1.0,
    riskTolerance: "BALANCED", executionPolicy: "NOW",
    maxWaitSeconds: 600, cancellationPolicy: "CANCEL_ANYTIME",
  });

  const initUsdcF = totalNetworkBalance(wF, "USDC");

  for (let i = 0; i < 25; i++) {
    simulateStep(wF, rngF);
  }

  const finalUsdcF = totalNetworkBalance(wF, "USDC");
  const failedTransfers = wF.settlementTransfers.filter(t => t.status === "FAILED");
  const completedTransfersF = wF.settlementTransfers.filter(t => t.status === "COMPLETED");

  console.log(`  Completed transfers: ${completedTransfersF.length}`);
  console.log(`  Failed (reversed) transfers: ${failedTransfers.length}`);
  console.log(`  USDC: ${initUsdcF.toFixed(2)} → ${finalUsdcF.toFixed(2)}`);

  // Even with failures, USDC must be conserved (reversals return assets to upstream).
  assert(approxEq(finalUsdcF, initUsdcF, 1.0),
    `Failure USDC conserved: ${initUsdcF.toFixed(2)} ≈ ${finalUsdcF.toFixed(2)} (within 1.0 tolerance for float arithmetic)`);

  // No negative balances.
  let negativeCount = 0;
  for (const p of wF.providers.values()) {
    for (const [, balance] of p.liquidity.balances) {
      if (balance < -0.01) negativeCount++;
    }
  }
  assert(negativeCount === 0, `No negative balances after failures (${negativeCount})`);

  // =========================================================================
  // 7. SUMMARY — four hard invariants
  // =========================================================================
  console.log("\n== 7. Four hard invariants ==");

  console.log(`  1. Settlement-asset conservation (USDC): ${approxEq(finalUsdc1, initUsdc1) ? "PASS" : "FAIL"}`);
  console.log(`  2. Settlement-asset conservation (3-hop USDC+EURC): ${approxEq(finalUsdc3, initUsdc3) && approxEq(finalEurc3, initEurc3) ? "PASS" : "FAIL"}`);
  console.log(`  3. Failure conservation: ${approxEq(finalUsdcF, initUsdcF, 1.0) ? "PASS" : "FAIL"}`);
  console.log(`  4. No negative balances: ${negativeCount === 0 ? "PASS" : "FAIL"}`);

  console.log(`\n========================================`);
  console.log(`  P4.7.2 Conservation: Passed: ${passed}  |  Failed: ${failed}`);
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
