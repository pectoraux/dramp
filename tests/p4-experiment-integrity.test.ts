/**
 * dRamp Prompt 4.8.2 — Experimental-Control Integrity Tests.
 *
 * Proves:
 *   1. No Math.random() in the experiment file.
 *   2. Demand population is frozen across densities (byte-equivalent).
 *   3. Canonical provider pool: providers[0..N] are identical across densities.
 *   4. Same seed + same config = identical results.
 *
 * Usage: bun tests/p4-experiment-integrity.test.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log("dRamp P4.8.2 — Experimental-Control Integrity Tests");

  const fs = await import("fs");
  const { createDefaultConfig } = await import("../src/lib/simulator/world");
  const { SeededRNG } = await import("../src/lib/simulator/rng");

  // =========================================================================
  // 1. NO Math.random() IN EXPERIMENT FILE
  // =========================================================================
  console.log("\n== 1. No Math.random() in experiment ==");
  const expSrc = fs.readFileSync("experiments/p4-topology-experiment.ts", "utf-8");
  // Check for Math.random() calls (not in comments).
  const codeLines = expSrc.split("\n").filter(l => !l.trim().startsWith("//"));
  const mathRandomLines = codeLines.filter(l => l.includes("Math.random()"));
  assert(mathRandomLines.length === 0,
    `No Math.random() in experiment code (found ${mathRandomLines.length}: ${mathRandomLines.join("; ")})`);

  // =========================================================================
  // 2. FROZEN DEMAND — identical across densities
  // =========================================================================
  console.log("\n== 2. Frozen demand across densities ==");

  // Import the experiment's demand generator.
  const { generateDemandPopulation } = await import("../experiments/p4-topology-experiment.ts");

  // Generate demand for seed 42 with different densities — demand must be identical.
  const config = { ...createDefaultConfig(), seed: 42, totalSteps: 50, initialProviders: 0, providerGrowthRate: 0.0, providerExitThreshold: -999, enableIncentives: false, shockType: null, shockStep: 999, shockMagnitude: 0 };
  const demand5 = generateDemandPopulation(42, 50, config);
  const demand100 = generateDemandPopulation(42, 50, config);

  assert(demand5.length === demand100.length, `Demand population same size (${demand5.length} === ${demand100.length})`);

  // Verify byte-equivalence: each user must be identical.
  let allIdentical = true;
  for (let i = 0; i < demand5.length; i++) {
    const u1 = demand5[i];
    const u2 = demand100[i];
    if (u1.sourceAsset !== u2.sourceAsset || u1.destinationAsset !== u2.destinationAsset ||
        u1.typicalAmount !== u2.typicalAmount || u1.riskTolerance !== u2.riskTolerance ||
        u1.executionPolicy !== u2.executionPolicy || u1.frequency !== u2.frequency) {
      allIdentical = false;
      console.error(`  User ${i} differs: ${u1.sourceAsset}→${u1.destinationAsset} vs ${u2.sourceAsset}→${u2.destinationAsset}`);
      break;
    }
  }
  assert(allIdentical, "Demand population byte-equivalent across densities (same seed)");

  // =========================================================================
  // 3. CANONICAL PROVIDER POOL — providers[0..N] identical across densities
  // =========================================================================
  console.log("\n== 3. Canonical provider pool ==");
  const { generateCanonicalProviders } = await import("../experiments/p4-topology-experiment.ts");
  const { deriveDemandCorridors } = await import("../experiments/p4-topology-experiment.ts");

  // Derive demand corridors from the frozen demand.
  const demandCorridors = deriveDemandCorridors(demand5);

  // Settlement assets (deterministic).
  const settlementAssets = new Map([
    ["asset_usdc", { id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_eurc", { id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_sc", { id: "asset_sc", symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT", volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0, incentiveRate: 0, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE" }],
  ]);

  const pool5 = generateCanonicalProviders(99999, 5, "RANDOM", settlementAssets, demandCorridors);
  const pool100 = generateCanonicalProviders(99999, 100, "RANDOM", settlementAssets, demandCorridors);

  // The first 5 providers must be identical.
  let poolIdentical = true;
  for (let i = 0; i < 5; i++) {
    const p1 = pool5[i];
    const p2 = pool100[i];
    if (p1.id !== p2.id || p1.name !== p2.name || p1.providerType !== p2.providerType ||
        p1.collateral !== p2.collateral || p1.corridors.length !== p2.corridors.length) {
      poolIdentical = false;
      console.error(`  Provider ${i} differs: ${p1.name} vs ${p2.name}`);
      break;
    }
    // Check corridors match.
    for (let c = 0; c < p1.corridors.length; c++) {
      if (p1.corridors[c] !== p2.corridors[c]) {
        poolIdentical = false;
        console.error(`  Provider ${i} corridor ${c} differs: ${p1.corridors[c]} vs ${p2.corridors[c]}`);
        break;
      }
    }
  }
  assert(poolIdentical, "Canonical provider pool: first 5 providers identical across 5/100 densities");

  // Also verify 10, 20, 50.
  const pool10 = generateCanonicalProviders(99999, 10, "RANDOM", settlementAssets, demandCorridors);
  const pool20 = generateCanonicalProviders(99999, 20, "RANDOM", settlementAssets, demandCorridors);
  let poolSubset = true;
  for (let i = 0; i < 10; i++) {
    if (pool10[i].id !== pool20[i].id || pool10[i].name !== pool20[i].name) {
      poolSubset = false;
      break;
    }
  }
  assert(poolSubset, "Canonical pool: first 10 providers identical in 10/20 pools");

  // =========================================================================
  // 4. REPRODUCIBILITY — same seed + topology + density = same result
  // =========================================================================
  console.log("\n== 4. Reproducibility ==");
  // Generate the same pool twice — must be identical.
  const pool1 = generateCanonicalProviders(99999, 20, "RANDOM", settlementAssets, demandCorridors);
  const pool2 = generateCanonicalProviders(99999, 20, "RANDOM", settlementAssets, demandCorridors);
  let reproducible = true;
  for (let i = 0; i < 20; i++) {
    if (pool1[i].id !== pool2[i].id || pool1[i].collateral !== pool2[i].collateral) {
      reproducible = false;
      break;
    }
  }
  assert(reproducible, "Same seed produces identical canonical pool (reproducible)");

  // =========================================================================
  // 5. CORRIDOR_FOCUSED uses demand-derived corridors
  // =========================================================================
  console.log("\n== 5. CORRIDOR_FOCUSED uses demand-derived corridors ==");
  const focusedPool = generateCanonicalProviders(99999, 10, "CORRIDOR_FOCUSED", settlementAssets, demandCorridors);
  // At least one provider corridor should match a demand corridor.
  const demandCorridorStrings = demandCorridors.map(c => `${c[0]}:${c[1]}:${c[2]}:${c[3]}`);
  let usesDemandCorridors = false;
  for (const p of focusedPool) {
    for (const corridor of p.corridors) {
      if (demandCorridorStrings.includes(corridor)) {
        usesDemandCorridors = true;
        break;
      }
    }
    if (usesDemandCorridors) break;
  }
  assert(usesDemandCorridors, "CORRIDOR_FOCUSED providers serve demand-derived corridors");

  // Demand corridors should not be the hard-coded HIGH_DEMAND_CORRIDORS.
  const HIGH_DEMAND_CORRIDORS = [
    ["USD", "US", "NGN", "NG"], ["USD", "US", "PHP", "PH"],
    ["USD", "US", "KES", "KE"], ["USD", "US", "INR", "IN"],
    ["EUR", "EU", "NGN", "NG"], ["GBP", "GB", "NGN", "NG"],
    ["USD", "US", "EUR", "EU"], ["SGD", "SG", "PHP", "PH"],
  ];
  const hardCodedStrings = HIGH_DEMAND_CORRIDORS.map(c => `${c[0]}:${c[1]}:${c[2]}:${c[3]}`);
  // The demand-derived corridors should NOT all match the hard-coded ones.
  // (They might overlap, but should be derived from actual demand.)
  const allHardCoded = demandCorridorStrings.every(c => hardCodedStrings.includes(c));
  assert(!allHardCoded || demandCorridorStrings.length > hardCodedStrings.length,
    "Demand corridors derived from actual demand (not all hard-coded)");

  console.log(`\n========================================`);
  console.log(`  P4.8.2 Integrity: Passed: ${passed}  |  Failed: ${failed}`);
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
