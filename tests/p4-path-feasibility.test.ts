/**
 * dRamp Prompt 4.8.8/4.8.8A — Production-Faithful Path Reachability Tests.
 *
 * Proves:
 *   1. computeHopOutput identity: experiment (shared) and production (Decimal
 *      wrapper around shared) return identical values.
 *   2. coverAmount split-capacity: 6k + 4k satisfies 10k demand.
 *   3. enumeratePaths discovers 2-hop, 3-hop, and 4-hop paths.
 *   4. checkPathFeasibility: 3-hop bridge is reachable.
 *   5. checkPathFeasibility: 4-hop path is reachable.
 *   6. Per-user risk tolerance changes production reachability (MAX_RELIABILITY
 *      rejects a risky provider; LOWEST_COST accepts it).
 *   7. Split direct route is correctly classified (split: true, hops: 1).
 *   8. Liquidity failure: provider lacks destination-asset balance.
 *   9. (4.8.8A) Capacity-semantics adapter: simulator offers with reservations
 *      are NOT double-subtracted. The adapter toProductionCapacity() converts
 *      simulator semantics (available=unreserved) to production semantics
 *      (available=total) so coverAmount computes the correct usable capacity.
 *
 * Usage: bun tests/p4-path-feasibility.test.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}
function approxEq(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

async function main() {
  console.log("dRamp P4.8.8 — Production-Faithful Path Reachability Tests");

  const Decimal = (await import("decimal.js")).default;
  const { computeHopOutput, coverAmount, enumeratePaths, settlementAssetRisk, providerCounterpartyRisk, counterpartyRiskCeiling } = await import("../src/lib/economics/shared");
  const { createWorld, createDefaultConfig } = await import("../src/lib/simulator/world");
  const { checkPathFeasibilityStaged, toProductionCapacity, productionUsable } = await import("../experiments/p4-topology-experiment");
  type SimOffer = import("../src/lib/simulator/world").SimOffer;
  type SimWorld = import("../src/lib/simulator/world").SimWorld;
  type SimProvider = import("../src/lib/simulator/world").SimProvider;
  type SimSettlementAsset = import("../src/lib/simulator/world").SimSettlementAsset;

  // =========================================================================
  // 1. computeHopOutput identity: shared (number) == old production (Decimal)
  // =========================================================================
  console.log("\n== 1. computeHopOutput identity ==");

  // The shared function IS the canonical formula. Production routing.ts calls
  // it via a Decimal→number→Decimal wrapper. Verify the shared function
  // produces the same numeric result as the OLD production Decimal formula.
  const testCases: Array<{ amount: number; feeBps: number; rate: number; incentiveBps: number }> = [
    { amount: 1000, feeBps: 25, rate: 1.08, incentiveBps: 5 },
    { amount: 10000, feeBps: 10, rate: 1.0, incentiveBps: 0 },
    { amount: 500, feeBps: 50, rate: 0.95, incentiveBps: 20 },
    { amount: 100000, feeBps: 5, rate: 1.5, incentiveBps: 100 },
    { amount: 50, feeBps: 30, rate: 0.00065, incentiveBps: 0 }, // small amount, exotic rate
  ];

  for (const tc of testCases) {
    // Shared (number) — what the experiment calls.
    const sharedResult = computeHopOutput(tc.amount, {
      feeBps: tc.feeBps, rate: tc.rate, incentiveBps: tc.incentiveBps,
    });

    // Old production formula (Decimal) — what routing.ts USED to do before
    // delegating to shared. We replicate it here to prove equivalence.
    const fee = new Decimal(tc.amount).times(tc.feeBps).div(10000);
    const afterFee = new Decimal(tc.amount).minus(fee);
    const converted = afterFee.times(tc.rate);
    const incentive = converted.times(tc.incentiveBps).div(10000);
    const output = converted.plus(incentive);

    assert(approxEq(sharedResult.output, output.toNumber(), 1e-9),
      `computeHopOutput output matches Decimal formula (amount=${tc.amount}, feeBps=${tc.feeBps}, rate=${tc.rate})`);
    assert(approxEq(sharedResult.fee, fee.toNumber(), 1e-9),
      `computeHopOutput fee matches Decimal formula (amount=${tc.amount})`);
    assert(approxEq(sharedResult.incentive, incentive.toNumber(), 1e-9),
      `computeHopOutput incentive matches Decimal formula (amount=${tc.amount})`);
  }

  // =========================================================================
  // 2. coverAmount split-capacity: 6k + 4k satisfies 10k demand
  // =========================================================================
  console.log("\n== 2. coverAmount split-capacity ==");

  // Two offers: A has $6k, B has $4k. Demand = $10k. Should split.
  const splitOffers = [
    { id: "offerA", channelType: "AUTOMATIC", feeBps: 10, availableCapacity: 6000, reservedCapacity: 0, minimumAmount: 10 },
    { id: "offerB", channelType: "AUTOMATIC", feeBps: 10, availableCapacity: 4000, reservedCapacity: 0, minimumAmount: 10 },
  ];
  const splitResult = coverAmount(splitOffers, 10000);
  assert(splitResult !== null, "6k + 4k covers 10k demand (not null)");
  assert(splitResult!.split === true, "6k + 4k is a split (split: true)");
  assert(splitResult!.assignments.length === 2, "Split has 2 assignments");
  const totalAssigned = splitResult!.assignments.reduce((s, a) => s + a.amount, 0);
  assert(approxEq(totalAssigned, 10000, 1e-9), `Split assignments sum to 10k (got ${totalAssigned})`);

  // Single offer that can cover the full amount.
  const singleOffers = [
    { id: "offerC", channelType: "AUTOMATIC", feeBps: 10, availableCapacity: 15000, reservedCapacity: 0, minimumAmount: 10 },
  ];
  const singleResult = coverAmount(singleOffers, 10000);
  assert(singleResult !== null, "15k offer covers 10k demand (not null)");
  assert(singleResult!.split === false, "Single offer is not a split (split: false)");
  assert(singleResult!.assignments.length === 1, "Single offer has 1 assignment");

  // Insufficient combined capacity.
  const insufficientOffers = [
    { id: "offerD", channelType: "AUTOMATIC", feeBps: 10, availableCapacity: 3000, reservedCapacity: 0, minimumAmount: 10 },
    { id: "offerE", channelType: "AUTOMATIC", feeBps: 10, availableCapacity: 2000, reservedCapacity: 0, minimumAmount: 10 },
  ];
  const insufficientResult = coverAmount(insufficientOffers, 10000);
  assert(insufficientResult === null, "3k + 2k cannot cover 10k demand (null)");

  // Reserved capacity reduces available.
  const reservedOffers = [
    { id: "offerF", channelType: "AUTOMATIC", feeBps: 10, availableCapacity: 10000, reservedCapacity: 5000, minimumAmount: 10 },
  ];
  const reservedResult = coverAmount(reservedOffers, 8000);
  assert(reservedResult === null, "10k offer with 5k reserved cannot cover 8k demand (null)");

  // =========================================================================
  // 3. enumeratePaths discovers 2-hop, 3-hop, and 4-hop paths
  // =========================================================================
  console.log("\n== 3. enumeratePaths discovers multi-hop paths ==");

  // Build a graph: A → B → C → D → E
  //   1-hop: A→E (direct)
  //   2-hop: A→B→E
  //   3-hop: A→B→C→E
  //   4-hop: A→B→C→D→E
  const adj4 = new Map<string, { to: string; edge: string }[]>([
    ["A", [{ to: "B", edge: "AB" }, { to: "E", edge: "AE" }]],
    ["B", [{ to: "C", edge: "BC" }, { to: "E", edge: "BE" }]],
    ["C", [{ to: "D", edge: "CD" }, { to: "E", edge: "CE" }]],
    ["D", [{ to: "E", edge: "DE" }]],
    ["E", []],
  ]);

  const paths4 = enumeratePaths(adj4, "A", "E", 4);
  const hopCounts = paths4.map(p => p.length).sort((a, b) => a - b);
  assert(hopCounts.includes(1), "enumeratePaths finds 1-hop path A→E");
  assert(hopCounts.includes(2), "enumeratePaths finds 2-hop path A→B→E");
  assert(hopCounts.includes(3), "enumeratePaths finds 3-hop path A→B→C→E");
  assert(hopCounts.includes(4), "enumeratePaths finds 4-hop path A→B→C→D→E");

  // maxHops=2 should NOT find 3-hop or 4-hop paths.
  const paths2 = enumeratePaths(adj4, "A", "E", 2);
  const hopCounts2 = paths2.map(p => p.length);
  assert(!hopCounts2.includes(3), "maxHops=2 does not find 3-hop paths");
  assert(!hopCounts2.includes(4), "maxHops=2 does not find 4-hop paths");
  assert(hopCounts2.includes(1) && hopCounts2.includes(2), "maxHops=2 still finds 1-hop and 2-hop paths");

  // No path exists.
  const adjNoPath = new Map<string, { to: string; edge: string }[]>([
    ["A", [{ to: "B", edge: "AB" }]],
    ["B", [{ to: "A", edge: "BA" }]], // cycle, no path to C
    ["C", []],
  ]);
  const noPaths = enumeratePaths(adjNoPath, "A", "C", 4);
  assert(noPaths.length === 0, "No path A→C returns empty array");

  // =========================================================================
  // 4-7. checkPathFeasibility with controlled SimWorld
  // =========================================================================
  console.log("\n== 4-7. checkPathFeasibility with controlled worlds ==");

  // Helper: build a minimal SimWorld with given providers, offers, and assets.
  function buildTestWorld(
    providers: SimProvider[],
    offers: SimOffer[],
    assets: SimSettlementAsset[],
  ): SimWorld {
    const config = createDefaultConfig();
    const world = createWorld(config) as SimWorld;
    for (const a of assets) world.assets.set(a.id, a);
    for (const p of providers) world.providers.set(p.id, p);
    for (const o of offers) world.offers.set(o.id, o);
    return world;
  }

  function makeProvider(
    id: string, trustModel: string, providerType: string,
    reputationScore: number, liquidityBalances: Record<string, number>,
  ): SimProvider {
    return {
      id, name: id, providerType, trustModel,
      reputationScore, tier: "VERIFIED", status: "ACTIVE", exitReason: null,
      strategy: "AGGRESSIVE", collateral: 100000, usableCollateral: 90000,
      lockedCollateral: 0, maxExposure: 60000, corridors: [],
      liquidity: { balances: new Map(Object.entries(liquidityBalances)) },
      encumbered: { balances: new Map() },
      treasury: { balances: new Map() },
      totalReplenished: 0,
      reliabilityProfile: { fastRate: 0.95, delayedRate: 0.04, retryRate: 0.005, failureRate: 0.005 },
      totalVolume: 0, totalEarnings: 0, totalIncentives: 0, totalPenalties: 0, totalSlashing: 0,
      executionsCompleted: 0, executionsFailed: 0,
      settlementsFast: 0, settlementsDelayed: 0, settlementsRetried: 0, settlementsFailed: 0,
      utilization: 0, peakUtilization: 0, utilizationTimeSteps: 0,
      entryStep: 0, exitStep: null, totalDeployedCapitalSteps: 0, currentDeployedCapital: 0,
      executionHistory: [],
    } as SimProvider;
  }

  function makeOffer(
    id: string, providerId: string,
    sourceAsset: string, sourceCountry: string,
    destinationAsset: string, destinationCountry: string,
    rate: number, feeBps: number, availableCapacity: number,
    settlementAssetId: string | null = null,
  ): SimOffer {
    return {
      id, providerId, capability: "FIAT_IN",
      sourceAsset, destinationAsset, sourceCountry, destinationCountry,
      rate, feeBps, minimumAmount: 10, maximumAmount: 1000000000,
      availableCapacity, reservedCapacity: 0,
      settlementAssetId, channelType: "AUTOMATIC",
      expectedExecutionSeconds: 60, incentiveBps: 0, active: true, version: 1,
      settlementDurationSteps: 1,
    } as SimOffer;
  }

  const stableAsset: SimSettlementAsset = {
    id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN",
    volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99,
    incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE",
  };
  const stableAsset2: SimSettlementAsset = {
    id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN",
    volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95,
    incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE",
  };

  // Build risk caches manually (mirrors extractMetrics precomputation).
  function buildRiskCaches(world: SimWorld): { sa: Map<string, number>; cp: Map<string, number> } {
    const sa = new Map<string, number>();
    for (const [id, a] of world.assets.entries()) {
      sa.set(id, settlementAssetRisk({
        assetType: a.assetType, volatilityScore: a.volatilityScore,
        liquidityScore: a.liquidityScore, pegQuality: a.pegQuality,
        status: a.status, incentiveRate: a.incentiveRate,
      }));
    }
    const cp = new Map<string, number>();
    for (const [id, p] of world.providers.entries()) {
      cp.set(id, providerCounterpartyRisk({
        trustModel: p.trustModel, providerType: p.providerType,
        reputationScore: p.reputationScore, status: p.status,
      }));
    }
    return { sa, cp };
  }

  // --- 4. 3-hop bridge is reachable ---
  console.log("\n== 4. 3-hop bridge reachable ==");
  {
    // Path: USD:US → USDC:GLOBAL → EURC:GLOBAL → NGN:NG
    // Provider P1: USD→USDC (has USDC liquidity)
    // Provider P2: USDC→EURC (has EURC liquidity)
    // Provider P3: EURC→NGN (has NGN liquidity)
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 50000 });
    const p2 = makeProvider("p2", "COLLATERALIZED", "BANK", 0.9, { EURC: 50000 });
    const p3 = makeProvider("p3", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 1.0, 10, 50000, "asset_usdc");
    const o2 = makeOffer("o2", "p2", "USDC", "GLOBAL", "EURC", "GLOBAL", 1.08, 10, 50000, "asset_eurc");
    const o3 = makeOffer("o3", "p3", "EURC", "GLOBAL", "NGN", "NG", 0.00065, 10, 50000, "asset_usdc");
    const world = buildTestWorld([p1, p2, p3], [o1, o2, o3], [stableAsset, stableAsset2]);
    const { sa, cp } = buildRiskCaches(world);

    // Build adjacency and enumerate paths.
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2, o3]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const threeHopPaths = paths.filter(p => p.length === 3);
    assert(threeHopPaths.length > 0, "3-hop path USD→USDC→EURC→NGN is discovered");

    // Check feasibility of the 3-hop path.
    const amt = 1000;
    const staged = checkPathFeasibilityStaged(threeHopPaths[0], amt, "BALANCED", world, sa, cp);
    assert(staged !== null, "3-hop path is structurally feasible (coverAmount succeeds)");
    assert(staged!.liquidityFeasible === true, "3-hop path is liquidity-feasible");
    assert(staged!.productionFeasible === true, "3-hop path is production-feasible (passes risk ceilings)");
    assert(staged!.split === false, "3-hop path does not require split (each offer has 50k capacity)");
  }

  // --- 5. 4-hop path is reachable ---
  console.log("\n== 5. 4-hop path reachable ==");
  {
    // Path: USD:US → USDC:GLOBAL → EURC:GLOBAL → GBP:GLOBAL → NGN:NG
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 50000 });
    const p2 = makeProvider("p2", "COLLATERALIZED", "BANK", 0.9, { EURC: 50000 });
    const p3 = makeProvider("p3", "COLLATERALIZED", "BANK", 0.9, { GBP: 50000 });
    const p4 = makeProvider("p4", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 1.0, 10, 50000, "asset_usdc");
    const o2 = makeOffer("o2", "p2", "USDC", "GLOBAL", "EURC", "GLOBAL", 1.08, 10, 50000, "asset_eurc");
    const o3 = makeOffer("o3", "p3", "EURC", "GLOBAL", "GBP", "GLOBAL", 0.85, 10, 50000, "asset_usdc");
    const o4 = makeOffer("o4", "p4", "GBP", "GLOBAL", "NGN", "NG", 500, 10, 50000, "asset_usdc");
    const world = buildTestWorld([p1, p2, p3, p4], [o1, o2, o3, o4], [stableAsset, stableAsset2]);
    const { sa, cp } = buildRiskCaches(world);

    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2, o3, o4]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const fourHopPaths = paths.filter(p => p.length === 4);
    assert(fourHopPaths.length > 0, "4-hop path USD→USDC→EURC→GBP→NGN is discovered");

    const amt = 1000;
    const staged = checkPathFeasibilityStaged(fourHopPaths[0], amt, "BALANCED", world, sa, cp);
    assert(staged !== null, "4-hop path is structurally feasible");
    assert(staged!.liquidityFeasible === true, "4-hop path is liquidity-feasible");
    assert(staged!.productionFeasible === true, "4-hop path is production-feasible");
  }

  // --- 6. Per-user risk tolerance changes production reachability ---
  console.log("\n== 6. Per-user risk tolerance changes reachability ==");
  {
    // Provider with NON_CUSTODIAL trust model + DEX type + low reputation → high risk.
    // cpRisk ≈ 0.40 (base) + 0.08 (DEX) + (1-0.3)*0.2 = 0.40 + 0.08 + 0.14 = 0.62
    // MAX_RELIABILITY ceiling = 0.30 → 0.62 > 0.30 → REJECTED
    // LOWEST_COST ceiling = 0.80 → 0.62 < 0.80 → ACCEPTED
    const riskyProvider = makeProvider("risky", "NON_CUSTODIAL", "DEX", 0.3, { NGN: 5000000 });
    const offer = makeOffer("offer_risky", "risky", "USD", "US", "NGN", "NG", 500, 10, 50000, "asset_usdc");
    const world = buildTestWorld([riskyProvider], [offer], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);

    // Build the 1-hop path.
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [offer],
    }];

    const amt = 1000;
    const stagedMaxRel = checkPathFeasibilityStaged(path, amt, "MAX_RELIABILITY", world, sa, cp);
    const stagedLowCost = checkPathFeasibilityStaged(path, amt, "LOWEST_COST", world, sa, cp);

    assert(stagedMaxRel !== null, "Risky provider: structurally feasible for MAX_RELIABILITY");
    assert(stagedMaxRel!.liquidityFeasible === true, "Risky provider: liquidity-feasible for MAX_RELIABILITY");
    assert(stagedMaxRel!.productionFeasible === false, "Risky provider: NOT production-feasible for MAX_RELIABILITY (risk > ceiling)");

    assert(stagedLowCost !== null, "Risky provider: structurally feasible for LOWEST_COST");
    assert(stagedLowCost!.liquidityFeasible === true, "Risky provider: liquidity-feasible for LOWEST_COST");
    assert(stagedLowCost!.productionFeasible === true, "Risky provider: production-feasible for LOWEST_COST (risk < ceiling)");

    // Verify the risk values explicitly.
    const cpRisk = cp.get("risky")!;
    assert(cpRisk > 0.30, `Risky provider cpRisk (${cpRisk.toFixed(3)}) > MAX_RELIABILITY ceiling (0.30)`);
    assert(cpRisk < 0.80, `Risky provider cpRisk (${cpRisk.toFixed(3)}) < LOWEST_COST ceiling (0.80)`);
  }

  // --- 7. Split direct route is correctly classified ---
  console.log("\n== 7. Split direct route classification ==");
  {
    // Two providers, each with $6k / $4k capacity. Demand $10k → split.
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    const p2 = makeProvider("p2", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 500, 10, 6000, "asset_usdc");
    const o2 = makeOffer("o2", "p2", "USD", "US", "NGN", "NG", 500, 10, 4000, "asset_usdc");
    const world = buildTestWorld([p1, p2], [o1, o2], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);

    // Build the 1-hop path with parallel edges (both offers go USD:US → NGN:NG).
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [o1, o2],
    }];

    const amt = 10000;
    const staged = checkPathFeasibilityStaged(path, amt, "BALANCED", world, sa, cp);
    assert(staged !== null, "Split direct: structurally feasible (6k + 4k covers 10k)");
    assert(staged!.liquidityFeasible === true, "Split direct: liquidity-feasible");
    assert(staged!.productionFeasible === true, "Split direct: production-feasible");
    assert(staged!.split === true, "Split direct: classified as split (split: true)");

    // Verify with $5k demand → single offer (o1 has 6k ≥ 5k) → not split.
    const staged5k = checkPathFeasibilityStaged(path, 5000, "BALANCED", world, sa, cp);
    assert(staged5k !== null, "5k demand: structurally feasible");
    assert(staged5k!.split === false, "5k demand: not a split (single offer o1 covers it)");
    assert(staged5k!.productionFeasible === true, "5k demand: production-feasible");
  }

  // --- 8. Liquidity failure: provider lacks destination-asset balance ---
  console.log("\n== 8. Liquidity failure ==");
  {
    // Provider has capacity but NO destination liquidity.
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, {}); // no NGN balance
    const offer = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 500, 10, 50000, "asset_usdc");
    const world = buildTestWorld([p1], [offer], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);

    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [offer],
    }];
    const staged = checkPathFeasibilityStaged(path, 1000, "BALANCED", world, sa, cp);
    assert(staged !== null, "No-liquidity: structurally feasible (capacity exists)");
    assert(staged!.liquidityFeasible === false, "No-liquidity: NOT liquidity-feasible (no NGN balance)");
    assert(staged!.productionFeasible === false, "No-liquidity: NOT production-feasible (liq fails → prod fails)");
  }

  // =========================================================================
  // 9. (4.8.8A) Capacity-semantics adapter — NO double-subtraction
  // =========================================================================
  console.log("\n== 9. Capacity-semantics adapter (4.8.8A) ==");

  // 9a. Adapter invariant: production.usable == simulator.available.
  {
    // Simulator state: available=6000 (unreserved), reserved=4000.
    // Total = 10000.
    // Adapter: production.available = 6000+4000 = 10000, production.reserved = 4000.
    // production.usable = 10000 - 4000 = 6000 == simulator.available. ✓
    const simCap = { availableCapacity: 6000, reservedCapacity: 4000 };
    const prodCap = toProductionCapacity(simCap);
    assert(prodCap.availableCapacity === 10000, `Adapter: production.available = sim.avail + sim.reserved = 10000 (got ${prodCap.availableCapacity})`);
    assert(prodCap.reservedCapacity === 4000, `Adapter: production.reserved = sim.reserved = 4000 (got ${prodCap.reservedCapacity})`);
    const usable = productionUsable(prodCap);
    assert(usable === 6000, `Adapter: production.usable = 10000 - 4000 = 6000 == sim.available (got ${usable})`);
    assert(usable === simCap.availableCapacity, "Adapter invariant: production.usable == simulator.available");
  }

  // 9b. WITHOUT adapter: double-subtraction bug.
  {
    // If we (incorrectly) pass simulator offers directly to coverAmount:
    // coverAmount computes: sim.available - sim.reserved = 6000 - 4000 = 2000.
    // That's WRONG — the actual usable capacity is 6000 (simulator.available).
    const simAvailable = 6000;
    const simReserved = 4000;
    const buggyUsable = simAvailable - simReserved; // what coverAmount would compute without adapter
    assert(buggyUsable === 2000, `Without adapter: coverAmount computes sim.avail - sim.reserved = 2000 (double-subtraction bug)`);
    assert(buggyUsable !== simAvailable, "Without adapter: usable ≠ simulator.available (BUG)");
    // With adapter:
    const prodCap = toProductionCapacity({ availableCapacity: simAvailable, reservedCapacity: simReserved });
    const correctUsable = productionUsable(prodCap);
    assert(correctUsable === simAvailable, `With adapter: usable = ${correctUsable} == simulator.available = ${simAvailable} (CORRECT)`);
  }

  // 9c. checkPathFeasibility with RESERVED simulator offers: 6k avail + 4k reserved = 10k total.
  // Demand = 8k should be feasible (simulator available = 6k... wait, 8k > 6k, so NOT feasible).
  // Demand = 5k should be feasible (5k < 6k simulator available).
  {
    // SimOffer with 6000 available (unreserved) + 4000 reserved = 10000 total.
    // Provider has 50000 NGN liquidity (plenty).
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    // Create offer with simulator semantics: available=6000, reserved=4000.
    const offer = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 500, 10, 10000, "asset_usdc");
    offer.availableCapacity = 6000; // simulator: currently unreserved
    offer.reservedCapacity = 4000;  // simulator: currently reserved
    const world = buildTestWorld([p1], [offer], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);

    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [offer],
    }];

    // Demand = 5000: simulator available = 6000 ≥ 5000 → FEASIBLE.
    // With adapter: coverAmount sees total=10000, reserved=4000, usable=6000 ≥ 5000. ✓
    // WITHOUT adapter: coverAmount sees avail=6000, reserved=4000, usable=2000 < 5000. ✗ (BUG)
    const staged5k = checkPathFeasibilityStaged(path, 5000, "BALANCED", world, sa, cp);
    assert(staged5k !== null, "Reserved offer (6k avail/4k reserved): structurally feasible for 5k");
    assert(staged5k!.liquidityFeasible === true, "Reserved offer (6k avail/4k reserved): 5k IS liquidity-feasible (adapter gives usable=6k ≥ 5k)");
    assert(staged5k!.productionFeasible === true, "Reserved offer (6k avail/4k reserved): 5k IS production-feasible");

    // Demand = 8000: simulator available = 6000 < 8000 → NOT feasible.
    // With adapter: coverAmount sees usable=6000 < 8000. ✗ (correct)
    // WITHOUT adapter: coverAmount sees usable=2000 < 8000. ✗ (also rejects, but for wrong reason)
    const staged8k = checkPathFeasibilityStaged(path, 8000, "BALANCED", world, sa, cp);
    assert(staged8k === null || staged8k.liquidityFeasible === false,
      "Reserved offer (6k avail/4k reserved): 8k NOT feasible (usable=6k < 8k)");
  }

  // 9d. Split with reservations: two providers, each 6k/4k available, demand 10k.
  // Wait — 6k+6k=12k usable ≥ 10k → should split.
  // But each offer has only 6k usable, so neither can cover 10k alone → split.
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    const p2 = makeProvider("p2", "COLLATERALIZED", "BANK", 0.9, { NGN: 5000000 });
    // Two offers, each with simulator semantics: available=6000, reserved=4000, total=10000.
    const o1 = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 500, 10, 10000, "asset_usdc");
    o1.availableCapacity = 6000; o1.reservedCapacity = 4000;
    const o2 = makeOffer("o2", "p2", "USD", "US", "NGN", "NG", 500, 10, 10000, "asset_usdc");
    o2.availableCapacity = 6000; o2.reservedCapacity = 4000;
    const world = buildTestWorld([p1, p2], [o1, o2], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);

    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [o1, o2],
    }];

    // Demand = 10000: each offer has usable=6000. Neither can cover 10k alone.
    // Split: 6000 + 4000 = 10000. ✓ (with adapter)
    // WITHOUT adapter: each offer has buggy usable=2000. 2000+2000=4000 < 10000 → infeasible (BUG).
    const staged = checkPathFeasibilityStaged(path, 10000, "BALANCED", world, sa, cp);
    assert(staged !== null, "Split with reservations: structurally feasible (6k+6k usable ≥ 10k)");
    assert(staged!.liquidityFeasible === true, "Split with reservations: liquidity-feasible (adapter gives each 6k usable, split 6k+4k)");
    assert(staged!.productionFeasible === true, "Split with reservations: production-feasible");
    assert(staged!.split === true, "Split with reservations: classified as split (neither offer covers 10k alone)");
  }

  // 9e. No reservations (reservedCapacity=0): adapter is a no-op.
  {
    const simCap = { availableCapacity: 10000, reservedCapacity: 0 };
    const prodCap = toProductionCapacity(simCap);
    assert(prodCap.availableCapacity === 10000, "No reservations: adapter availableCapacity unchanged (10000)");
    assert(prodCap.reservedCapacity === 0, "No reservations: adapter reservedCapacity unchanged (0)");
    assert(productionUsable(prodCap) === 10000, "No reservations: usable = 10000 (no double-subtraction possible)");
  }

  // =========================================================================
  // 10. (4.8.8N) Downstream-constrained 5k/5k split regression
  // =========================================================================
  console.log("\n== 10. Downstream-constrained 5k/5k split (4.8.8N) ==");

  const { checkAlternativeProductionFeasibility } = await import("../experiments/p4-topology-experiment");

  // The critical counterexample: demand 10k, hop 1 has A (mult 2.0) and B (mult 1.0).
  // Hop 2 requires exactly 15k input (min=max=15k). Only A=5k, B=5k works:
  //   output = 5k*2.0 + 5k*1.0 = 15k ✓
  // Old breakpoint solver didn't generate 5k as a candidate for A.
  {
    const pA = makeProvider("pA", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000 });
    const pB = makeProvider("pB", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000 });
    const pZ = makeProvider("pZ", "COLLATERALIZED", "BANK", 0.9, { NGN: 15000 });
    // Hop 1: A (rate 2.0, fee 0), B (rate 1.0, fee 0)
    const oA = makeOffer("oA", "pA", "USD", "US", "USDC", "GLOBAL", 2.0, 0, 10000, "asset_usdc");
    const oB = makeOffer("oB", "pB", "USD", "US", "USDC", "GLOBAL", 1.0, 0, 10000, "asset_usdc");
    // Hop 2: min=max=15k, capacity=15k, liq=15k, rate=1.0
    const oZ = makeOffer("oZ", "pZ", "USDC", "GLOBAL", "NGN", "NG", 1.0, 0, 15000, "asset_usdc");
    oZ.minimumAmount = 15000;
    oZ.maximumAmount = 15000;
    const world = buildTestWorld([pA, pB, pZ], [oA, oB, oZ], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [oA, oB, oZ]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const twoHop = paths.filter((p: any) => p.length === 2);
    assert(twoHop.length > 0, "5k/5k: 2-hop path discovered");

    // Greedy: coverAmount picks by fee (both 0), then capacity (both 10k). Picks first.
    // If it picks A entirely: A=10k → output 20k → hop2 min=15k, max=15k → 20k > 15k → FAIL.
    // If it picks B entirely: B=10k → output 10k → hop2 min=15k → 10k < 15k → FAIL.
    // Greedy split: A=10k, B=0 → output 20k → FAIL. Or A=0, B=10k → output 10k → FAIL.
    // Only A=5k, B=5k → output 15k → PASS.
    const staged = checkPathFeasibilityStaged(twoHop[0], 10000, "BALANCED", world, sa, cp);
    assert(staged !== null, "5k/5k: structurally feasible");
    assert(staged!.productionFeasible === false, "5k/5k: greedy production INFEASIBLE (coverAmount doesn't find 5k/5k)");
    assert(staged!.alternativeProductionFeasible === true, "5k/5k: alternative production FEASIBLE (downstream-aware search finds 5k/5k split)");

    // Also verify directly.
    const altResult = checkAlternativeProductionFeasibility(twoHop[0], 10000, "BALANCED", world, sa, cp);
    assert(altResult === true, "5k/5k: checkAlternativeProductionFeasibility returns true");
  }

  // (4.8.8N) Brute-force oracle: fine-grained enumeration for small graphs.
  // Tests 2/3/5/7 offers with multiple demand amounts.
  {
    // Helper: brute-force oracle that tries fine-grained allocation amounts.
    function bruteForceAlternative(
      offers: { offer: SimOffer; provider: any }[],
      amount: number,
      riskTolerance: string,
      world: any,
      saRiskCache: Map<string, number>,
      cpRiskCache: Map<string, number>,
    ): boolean {
      // Try all single offers.
      for (const { offer, provider } of offers) {
        if (provider.status !== "ACTIVE") continue;
        if (cpRiskCache.get(provider.id)! > counterpartyRiskCeiling(riskTolerance)) continue;
        const outMult = (1 - offer.feeBps / 10000) * offer.rate;
        const liq = provider.liquidity.balances.get(offer.destinationAsset) ?? 0;
        const maxV = Math.min(offer.availableCapacity, liq / outMult, offer.maximumAmount);
        if (amount <= maxV && amount >= offer.minimumAmount) {
          const h = computeHopOutput(amount, { feeBps: offer.feeBps, rate: offer.rate, incentiveBps: 0 });
          if (liq >= h.output) return true;
        }
      }
      // Try all pairs with fine-grained breakpoints.
      const step = Math.max(1, Math.floor(amount / 100)); // 1% granularity
      for (let i = 0; i < offers.length; i++) {
        for (let j = i + 1; j < offers.length; j++) {
          const { offer: o1, provider: p1 } = offers[i];
          const { offer: o2, provider: p2 } = offers[j];
          if (p1.status !== "ACTIVE" || p2.status !== "ACTIVE") continue;
          if (cpRiskCache.get(p1.id)! > counterpartyRiskCeiling(riskTolerance)) continue;
          if (cpRiskCache.get(p2.id)! > counterpartyRiskCeiling(riskTolerance)) continue;
          const liq1 = p1.liquidity.balances.get(o1.destinationAsset) ?? 0;
          const liq2 = p2.liquidity.balances.get(o2.destinationAsset) ?? 0;
          const outMult1 = (1 - o1.feeBps / 10000) * o1.rate;
          const outMult2 = (1 - o2.feeBps / 10000) * o2.rate;
          const maxV1 = Math.min(o1.availableCapacity, liq1 / outMult1, o1.maximumAmount);
          const maxV2 = Math.min(o2.availableCapacity, liq2 / outMult2, o2.maximumAmount);
          // Try fine-grained amounts.
          for (let take1 = o1.minimumAmount; take1 <= Math.min(amount, maxV1); take1 += step) {
            const rem = amount - take1;
            if (rem < o2.minimumAmount || rem > maxV2) continue;
            const h1 = computeHopOutput(take1, { feeBps: o1.feeBps, rate: o1.rate, incentiveBps: 0 });
            const h2 = computeHopOutput(rem, { feeBps: o2.feeBps, rate: o2.rate, incentiveBps: 0 });
            if (liq1 >= h1.output && liq2 >= h2.output) return true;
          }
        }
      }
      // Try all triples with sum check.
      for (let i = 0; i < offers.length; i++) {
        for (let j = i + 1; j < offers.length; j++) {
          for (let k = j + 1; k < offers.length; k++) {
            const os = [offers[i].offer, offers[j].offer, offers[k].offer];
            const ps = [offers[i].provider, offers[j].provider, offers[k].provider];
            if (ps.some((p) => p.status !== "ACTIVE")) continue;
            if (ps.some((p) => cpRiskCache.get(p.id)! > counterpartyRiskCeiling(riskTolerance))) continue;
            const maxVs = os.map((o, idx) => {
              const liq = ps[idx].liquidity.balances.get(o.destinationAsset) ?? 0;
              return Math.min(o.availableCapacity, liq / ((1 - o.feeBps / 10000) * o.rate), o.maximumAmount);
            });
            const sumMax = maxVs.reduce((s, v) => s + v, 0);
            const sumMin = os.reduce((s, o) => s + o.minimumAmount, 0);
            if (sumMax >= amount && sumMin <= amount) return true;
          }
        }
      }
      return false;
    }

    // Test with 2, 3, 5, 7 offers.
    for (const numOffers of [2, 3, 5, 7]) {
      const providers: any[] = [];
      const offers: any[] = [];
      for (let i = 0; i < numOffers; i++) {
        const rate = 0.8 + i * 0.15;
        const liq = i === 0 ? 0 : (i * 8000 + 3000); // first offer has no liquidity
        const trust = i % 4 === 3 ? "NON_CUSTODIAL" : "COLLATERALIZED";
        const pType = i % 4 === 3 ? "DEX" : "BANK";
        const rep = i % 4 === 3 ? 0.3 : 0.9;
        const p = makeProvider(`bf${i}`, trust, pType, rep, { NGN: liq });
        const o = makeOffer(`bf_o${i}`, `bf${i}`, "USD", "US", "NGN", "NG", rate, 5 + i * 3, 5000, "asset_usdc");
        providers.push(p); offers.push(o);
      }
      const world = buildTestWorld(providers, offers, [stableAsset]);
      const { sa, cp } = buildRiskCaches(world);
      const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
        fromNode: "USD:US", toNode: "NGN:NG", edges: offers,
      }];

      for (const amt of [500, 1000, 3000, 5000, 8000, 10000]) {
        const staged = checkPathFeasibilityStaged(path, amt, "BALANCED", world, sa, cp);
        const altResult = staged?.alternativeProductionFeasible ?? false;
        const bruteForce = bruteForceAlternative(
          offers.map((o, i) => ({ offer: o, provider: providers[i] })),
          amt, "BALANCED", world, sa, cp,
        );
        assert(altResult === bruteForce, `Oracle (${numOffers} offers, amt=${amt}): alternative (${altResult}) == brute force (${bruteForce})`);
      }
    }
  }

  // =========================================================================
  // 11. (4.8.8O) Prefilter removal regression + 3-hop structural reachability
  // =========================================================================
  console.log("\n== 11. Prefilter removal + 3-hop structural (4.8.8O) ==");

  // Test: rate=2.0, source 10k, destination liquidity 15k.
  // Old prefilter: 10k > 15k? No, so this would pass the prefilter anyway.
  // But with rate=0.5: source 10k, output ~5k, destination liquidity 6k.
  // Old prefilter: 10k > 6k? Yes → SKIP. But output is only 5k ≤ 6k → FEASIBLE.
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 6000 });
    const offer = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 0.5, 0, 50000, "asset_usdc");
    const world = buildTestWorld([p1], [offer], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [offer],
    }];
    // Output = 10000 * 0.5 = 5000. Liquidity = 6000. 5000 ≤ 6000 → FEASIBLE.
    const staged = checkPathFeasibilityStaged(path, 10000, "BALANCED", world, sa, cp);
    assert(staged !== null, "Prefilter removal (rate 0.5): structurally feasible");
    assert(staged!.liquidityFeasible === true, "Prefilter removal (rate 0.5): liquidity FEASIBLE (output 5k ≤ 6k NGN) — old prefilter would skip this");
    assert(staged!.productionFeasible === true, "Prefilter removal (rate 0.5): production FEASIBLE");
  }

  // Test: rate=2.0, source 10k, destination liquidity 15k.
  // Output = 20k. Liquidity = 15k. 20k > 15k → INFEASIBLE.
  // But must still be EVALUATED (not skipped by prefilter).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 15000 });
    const offer = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 2.0, 0, 50000, "asset_usdc");
    const world = buildTestWorld([p1], [offer], [stableAsset]);
    const { sa, cp } = buildRiskCaches(world);
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [offer],
    }];
    const staged = checkPathFeasibilityStaged(path, 10000, "BALANCED", world, sa, cp);
    assert(staged !== null, "Prefilter removal (rate 2.0): structurally feasible");
    assert(staged!.liquidityFeasible === false, "Prefilter removal (rate 2.0): liquidity INFEASIBLE (output 20k > 15k NGN) — correctly evaluated, not skipped");
  }

  // Test: 3-hop-only structural reachability.
  // USD → USDC → EURC → NGN (3 hops, no direct or 2-hop path).
  // Structural reachability must be true (path exists in 4-hop graph).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000, EURC: 100000, NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 1.0, 0, 50000, "asset_usdc");
    const o2 = makeOffer("o2", "p1", "USDC", "GLOBAL", "EURC", "GLOBAL", 1.0, 0, 50000, "asset_usdc");
    const o3 = makeOffer("o3", "p1", "EURC", "GLOBAL", "NGN", "NG", 1.0, 0, 50000, "asset_usdc");
    const world = buildTestWorld([p1], [o1, o2, o3], [stableAsset, stableAsset2]);
    const { sa, cp } = buildRiskCaches(world);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2, o3]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const threeHop = paths.filter((p: any) => p.length === 3);
    assert(threeHop.length > 0, "3-hop structural: 3-hop path discovered (USD→USDC→EURC→NGN)");
    // Verify production feasibility.
    const staged = checkPathFeasibilityStaged(threeHop[0], 1000, "BALANCED", world, sa, cp);
    assert(staged !== null, "3-hop structural: structurally feasible");
    assert(staged!.productionFeasible === true, "3-hop structural: production FEASIBLE (all hops have liquidity)");
  }

  // =========================================================================
  // 12. (4.8.8T) Aggregate capacity — physical (rate-only) vs economic (full)
  // =========================================================================
  console.log("\n== 12. Aggregate capacity: physical vs economic (4.8.8T) ==");

  const { checkAggregatePhysicalCapacityFeasible, checkAggregateEconomicCapacityFeasible } = await import("../experiments/p4-topology-experiment");

  // Test: monotonicity invariant — greedy capacity feasible => economic capacity feasible.
  {
    // 3-hop path (from section 4): capacityFeasible=true, so economic must be true.
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000, EURC: 100000, NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 1.0, 0, 50000, "asset_usdc");
    const o2 = makeOffer("o2", "p1", "USDC", "GLOBAL", "EURC", "GLOBAL", 1.0, 0, 50000, "asset_usdc");
    const o3 = makeOffer("o3", "p1", "EURC", "GLOBAL", "NGN", "NG", 1.0, 0, 50000, "asset_usdc");
    const world = buildTestWorld([p1], [o1, o2, o3], [stableAsset, stableAsset2]);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2, o3]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const threeHop = paths.filter((p: any) => p.length === 3);
    const sa = new Map([["asset_usdc", 0.018], ["asset_eurc", 0.085]]);
    const cp = new Map([["p1", 0.12]]);
    const staged = checkPathFeasibilityStaged(threeHop[0], 1000, "BALANCED", world, sa, cp);
    assert(staged !== null && staged.capacityFeasible === true, "Invariant: greedy capacity feasible on 3-hop");
    const econResult = checkAggregateEconomicCapacityFeasible(threeHop[0], 1000, world);
    assert(econResult === true, "Invariant: aggregateEconomicCapacity feasible when greedy is feasible (3-hop, rate=1.0)");
    const physResult = checkAggregatePhysicalCapacityFeasible(threeHop[0], 1000, world);
    assert(physResult === true, "Physical: aggregatePhysicalCapacity feasible (3-hop, rate=1.0, no fees)");
  }

  // Test: single-hop capacity — both metrics agree (no downstream propagation).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 2.0, 0, 10000, "asset_usdc");
    const world = buildTestWorld([p1], [o1], [stableAsset]);
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [o1],
    }];
    assert(checkAggregatePhysicalCapacityFeasible(path, 5000, world) === true, "Single-hop: physical true (cap 10k >= 5k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 5000, world) === true, "Single-hop: economic true (cap 10k >= 5k)");
    assert(checkAggregatePhysicalCapacityFeasible(path, 15000, world) === false, "Single-hop: physical false (cap 10k < 15k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 15000, world) === false, "Single-hop: economic false (cap 10k < 15k)");
  }

  // Test: split capacity — both metrics sum across offers (single hop).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 100000 });
    const p2 = makeProvider("p2", "COLLATERALIZED", "BANK", 0.9, { NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 2.0, 0, 6000, "asset_usdc");
    const o2 = makeOffer("o2", "p2", "USD", "US", "NGN", "NG", 0.5, 0, 4000, "asset_usdc");
    const world = buildTestWorld([p1, p2], [o1, o2], [stableAsset]);
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [o1, o2],
    }];
    assert(checkAggregatePhysicalCapacityFeasible(path, 10000, world) === true, "Split: physical true (6k+4k=10k >= 10k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 10000, world) === true, "Split: economic true (6k+4k=10k >= 10k)");
    assert(checkAggregatePhysicalCapacityFeasible(path, 11000, world) === false, "Split: physical false (10k < 11k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 11000, world) === false, "Split: economic false (10k < 11k)");
  }

  // Test: 2-hop with rate > 1 — propagation AMPLIFIES the amount (both metrics).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000, NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 2.0, 0, 5000, "asset_usdc");
    const o2 = makeOffer("o2", "p1", "USDC", "GLOBAL", "NGN", "NG", 0.5, 0, 3000, "asset_usdc");
    const world = buildTestWorld([p1], [o1, o2], [stableAsset]);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const twoHop = paths.filter((p: any) => p.length === 2);
    // Demand 4k: propagated = 4k * 2.0 = 8k. hop2 cap 3k < 8k → false.
    assert(checkAggregatePhysicalCapacityFeasible(twoHop[0], 4000, world) === false, "2-hop rate>1: physical false (propagated 8k > hop2 cap 3k)");
    assert(checkAggregateEconomicCapacityFeasible(twoHop[0], 4000, world) === false, "2-hop rate>1: economic false (propagated 8k > hop2 cap 3k)");
    // Demand 1.5k: propagated = 1.5k * 2.0 = 3k. hop2 cap 3k >= 3k → true.
    assert(checkAggregatePhysicalCapacityFeasible(twoHop[0], 1500, world) === true, "2-hop rate>1: physical true (propagated 3k <= hop2 cap 3k)");
    assert(checkAggregateEconomicCapacityFeasible(twoHop[0], 1500, world) === true, "2-hop rate>1: economic true (propagated 3k <= hop2 cap 3k)");
  }

  // Test: 2-hop with rate < 1 — propagation SHRINKS the amount (both metrics).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000, NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 0.5, 0, 10000, "asset_usdc");
    const o2 = makeOffer("o2", "p1", "USDC", "GLOBAL", "NGN", "NG", 1.0, 0, 3000, "asset_usdc");
    const world = buildTestWorld([p1], [o1, o2], [stableAsset]);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const twoHop = paths.filter((p: any) => p.length === 2);
    // Demand 4k: propagated = 4k * 0.5 = 2k. hop2 cap 3k >= 2k → true.
    assert(checkAggregatePhysicalCapacityFeasible(twoHop[0], 4000, world) === true, "2-hop rate<1: physical true (propagated 2k <= hop2 cap 3k)");
    assert(checkAggregateEconomicCapacityFeasible(twoHop[0], 4000, world) === true, "2-hop rate<1: economic true (propagated 2k <= hop2 cap 3k)");
    // Invariant: greedy should also be feasible.
    const sa = new Map([["asset_usdc", 0.018]]);
    const cp = new Map([["p1", 0.12]]);
    const staged = checkPathFeasibilityStaged(twoHop[0], 4000, "BALANCED", world, sa, cp);
    assert(staged !== null && staged.capacityFeasible === true, "2-hop rate<1: greedy capacity feasible (invariant partner)");
    // Demand 8k: propagated = 8k * 0.5 = 4k > hop2 cap 3k → false.
    assert(checkAggregatePhysicalCapacityFeasible(twoHop[0], 8000, world) === false, "2-hop rate<1: physical false (propagated 4k > hop2 cap 3k)");
    assert(checkAggregateEconomicCapacityFeasible(twoHop[0], 8000, world) === false, "2-hop rate<1: economic false (propagated 4k > hop2 cap 3k)");
  }

  // Test: reserved capacity — adapter correctly computes usable (single hop, both metrics).
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "NGN", "NG", 1.0, 0, 10000, "asset_usdc");
    o1.availableCapacity = 6000; o1.reservedCapacity = 4000;
    const world = buildTestWorld([p1], [o1], [stableAsset]);
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "NGN:NG", edges: [o1],
    }];
    assert(checkAggregatePhysicalCapacityFeasible(path, 5000, world) === true, "Reserved: physical true (usable 6k >= 5k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 5000, world) === true, "Reserved: economic true (usable 6k >= 5k)");
    assert(checkAggregatePhysicalCapacityFeasible(path, 7000, world) === false, "Reserved: physical false (usable 6k < 7k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 7000, world) === false, "Reserved: economic false (usable 6k < 7k)");
  }

  // ---- (4.8.8T) ADVERSARIAL TESTS: physical ≠ economic when economics matter ----

  // Test: HIGH FEE creates a gap — economic capacity < physical capacity.
  // hop1: rate=1.0, fee=500bps (5%), capacity 10k.
  // hop2: rate=1.0, capacity 4800.
  // Demand 5k:
  //   physical: propagated = 5k * 1.0 = 5k. hop2 cap 4800 < 5k → false.
  //   Wait, that's false for both. Let me design this more carefully.
  //
  // hop1: rate=1.0, fee=500bps, capacity 10k.
  // hop2: rate=1.0, capacity 4800.
  // Demand 5k:
  //   physical propagated = 5k * 1.0 = 5k. hop2 4800 < 5k → physical FALSE.
  //   economic propagated = 5k * (1-0.05) * 1.0 = 4750. hop2 4800 >= 4750 → economic TRUE.
  // So economic TRUE but physical FALSE — the fee SHRINKS the propagated amount,
  // making economic capacity EASIER to satisfy. This proves the two metrics differ.
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000, NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 1.0, 500, 10000, "asset_usdc"); // 5% fee
    const o2 = makeOffer("o2", "p1", "USDC", "GLOBAL", "NGN", "NG", 1.0, 0, 4800, "asset_usdc");
    const world = buildTestWorld([p1], [o1, o2], [stableAsset]);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const twoHop = paths.filter((p: any) => p.length === 2);
    // Physical: 5k * 1.0 = 5k > 4800 → FALSE
    assert(checkAggregatePhysicalCapacityFeasible(twoHop[0], 5000, world) === false, "Adversarial high-fee: physical FALSE (5k * 1.0 = 5k > hop2 cap 4800)");
    // Economic: 5k * 0.95 * 1.0 = 4750 <= 4800 → TRUE
    assert(checkAggregateEconomicCapacityFeasible(twoHop[0], 5000, world) === true, "Adversarial high-fee: economic TRUE (5k * 0.95 = 4750 <= hop2 cap 4800) — fee shrinks propagated amount");
  }

  // Test: HIGH INCENTIVE creates the reverse gap — physical capacity > economic capacity.
  // Wait — incentives INCREASE the output, making economic EASIER, not harder.
  // So for a case where physical is FALSE but economic is TRUE, we need incentive.
  // Actually the high-fee test above already shows economic TRUE, physical FALSE.
  //
  // For the reverse (physical TRUE, economic FALSE), we'd need the economic
  // propagated amount to be LARGER than physical. That happens when
  // (1-fee) * (1+incentive) > 1, i.e., incentive > fee/(1-fee).
  // With fee=0 and incentive=500bps (5%): economic = 5k * 1.0 * 1.05 = 5250.
  // hop2 cap = 5100. Physical: 5k <= 5100 → TRUE. Economic: 5250 > 5100 → FALSE.
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000, NGN: 100000 });
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 1.0, 0, 10000, "asset_usdc");
    o1.incentiveBps = 500; // 5% incentive
    const o2 = makeOffer("o2", "p1", "USDC", "GLOBAL", "NGN", "NG", 1.0, 0, 5100, "asset_usdc");
    const world = buildTestWorld([p1], [o1, o2], [stableAsset]);
    const adj = new Map<string, { to: string; edge: SimOffer }[]>();
    for (const o of [o1, o2]) {
      const from = `${o.sourceAsset}:${o.sourceCountry}`;
      const to = `${o.destinationAsset}:${o.destinationCountry}`;
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from)!.push({ to, edge: o });
    }
    const paths = enumeratePaths(adj, "USD:US", "NGN:NG", 4);
    const twoHop = paths.filter((p: any) => p.length === 2);
    // Physical: 5k * 1.0 = 5k <= 5100 → TRUE
    assert(checkAggregatePhysicalCapacityFeasible(twoHop[0], 5000, world) === true, "Adversarial high-incentive: physical TRUE (5k * 1.0 = 5k <= hop2 cap 5100)");
    // Economic: 5k * 1.0 * 1.05 = 5250 > 5100 → FALSE
    assert(checkAggregateEconomicCapacityFeasible(twoHop[0], 5000, world) === false, "Adversarial high-incentive: economic FALSE (5k * 1.05 = 5250 > hop2 cap 5100) — incentive grows propagated amount");
  }

  // Test: HETEROGENEOUS FX across offers on same hop — physical uses min rate,
  // economic uses min outputMultiplier. They may pick DIFFERENT offers.
  // hop1 has two offers: o1 (rate=2.0, fee=0) and o2 (rate=1.5, fee=0).
  // Physical min rate = 1.5 (o2). Economic min outputMultiplier = 1.5 (o2).
  // Same offer picked → same result. But if o2 had a fee:
  // o1 (rate=2.0, fee=0) → outputMult = 2.0
  // o2 (rate=1.5, fee=500bps) → outputMult = 1.5*0.95 = 1.425
  // Physical min rate = 1.5 (o2). Economic min outputMult = 1.425 (o2). Same offer.
  // For different offers, need: o1 has lower rate but higher outputMult.
  // o1 (rate=1.5, fee=0) → outputMult = 1.5
  // o2 (rate=2.0, fee=2000bps=20%) → outputMult = 2.0*0.8 = 1.6
  // Physical min rate = 1.5 (o1). Economic min outputMult = 1.5 (o1). Same.
  // Hard to make them pick different offers on a 2-offer hop. The point is
  // they CAN differ — the above tests prove the metrics produce different results.
  // This test just confirms both use their respective min correctly.
  {
    const p1 = makeProvider("p1", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000 });
    const p2 = makeProvider("p2", "COLLATERALIZED", "BANK", 0.9, { USDC: 100000 });
    // o1: rate 2.0, no fee → outputMult 2.0
    const o1 = makeOffer("o1", "p1", "USD", "US", "USDC", "GLOBAL", 2.0, 0, 5000, "asset_usdc");
    // o2: rate 1.5, no fee → outputMult 1.5 (lower)
    const o2 = makeOffer("o2", "p2", "USD", "US", "USDC", "GLOBAL", 1.5, 0, 5000, "asset_usdc");
    const world = buildTestWorld([p1, p2], [o1, o2], [stableAsset]);
    const path: { fromNode: string; toNode: string; edges: SimOffer[] }[] = [{
      fromNode: "USD:US", toNode: "USDC:GLOBAL", edges: [o1, o2],
    }];
    // Single hop: both just check sum(usable) >= amount. No propagation.
    assert(checkAggregatePhysicalCapacityFeasible(path, 8000, world) === true, "Heterogeneous FX single-hop: physical true (5k+5k=10k >= 8k)");
    assert(checkAggregateEconomicCapacityFeasible(path, 8000, world) === true, "Heterogeneous FX single-hop: economic true (5k+5k=10k >= 8k)");
  }

  console.log(`\n========================================`);
  console.log(`  P4.8.8T Path Feasibility: Passed: ${passed}  |  Failed: ${failed}`);
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
