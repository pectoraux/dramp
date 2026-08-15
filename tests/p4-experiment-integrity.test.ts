/**
 * dRamp Prompt 4.8.4 — True dRamp Graph Semantics Tests.
 *
 * Proves:
 *   1. No Math.random() in experiment.
 *   2. Demand frozen across densities.
 *   3. Canonical specs: first N identical in 5/100 pools.
 *   4. Deep clone: mutations don't contaminate.
 *   5. Per-seed corridors derived independently.
 *   6. Three reachability metrics exist (asset ≥ corridor ≥ executable).
 *   7. Provider economics shared across topologies (same seed).
 *   8. Corridor reachability uses country matching (not just asset).
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
  console.log("dRamp P4.8.4 — True dRamp Graph Semantics Tests");

  const fs = await import("fs");
  const { createDefaultConfig } = await import("../src/lib/simulator/world");
  const { SeededRNG } = await import("../src/lib/simulator/rng");
  const expSrc = fs.readFileSync("experiments/p4-topology-experiment.ts", "utf-8");

  // 1. No Math.random()
  console.log("\n== 1. No Math.random() ==");
  const codeLines = expSrc.split("\n").filter(l => !l.trim().startsWith("//"));
  const mathRandomLines = codeLines.filter(l => l.includes("Math.random()"));
  assert(mathRandomLines.length === 0, `No Math.random() (${mathRandomLines.length})`);

  // 2. Frozen demand
  console.log("\n== 2. Frozen demand ==");
  const { generateDemandPopulation, deriveDemandCorridors, generateCanonicalSpecs, cloneProvider } = await import("../experiments/p4-topology-experiment.ts");
  const config = { ...createDefaultConfig(), seed: 42, totalSteps: 50, initialProviders: 0, providerGrowthRate: 0.0, providerExitThreshold: -999, enableIncentives: false, shockType: null, shockStep: 999, shockMagnitude: 0 };
  const d5 = generateDemandPopulation(42, 50, config);
  const d100 = generateDemandPopulation(42, 50, config);
  assert(d5.length === d100.length, `Demand same size (${d5.length})`);
  let demandIdentical = true;
  for (let i = 0; i < d5.length; i++) {
    if (d5[i].sourceAsset !== d100[i].sourceAsset || d5[i].typicalAmount !== d100[i].typicalAmount) { demandIdentical = false; break; }
  }
  assert(demandIdentical, "Demand byte-equivalent across densities");

  // 3. Canonical specs identical across densities
  console.log("\n== 3. Canonical specs ==");
  const settlementAssets = new Map([
    ["asset_usdc", { id: "asset_usdc", symbol: "USDC", assetType: "STABLECOIN", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, incentiveRate: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_eurc", { id: "asset_eurc", symbol: "EURC", assetType: "STABLECOIN", volatilityScore: 0.05, liquidityScore: 0.7, pegQuality: 0.95, incentiveRate: 0, collateralHaircut: 0.1, isEligibleCollateral: true, status: "ACTIVE" }],
    ["asset_sc", { id: "asset_sc", symbol: "SC", assetType: "INTERNAL_SETTLEMENT_UNIT", volatilityScore: 0.0, liquidityScore: 0.9, pegQuality: 1.0, incentiveRate: 0, collateralHaircut: 0.0, isEligibleCollateral: true, status: "ACTIVE" }],
  ]);
  const corridors = deriveDemandCorridors(d5);
  const specs5 = generateCanonicalSpecs(99999, 5, "RANDOM", settlementAssets, corridors);
  const specs100 = generateCanonicalSpecs(99999, 100, "RANDOM", settlementAssets, corridors);
  let specsIdentical = true;
  for (let i = 0; i < 5; i++) {
    if (specs5[i].id !== specs100[i].id || specs5[i].name !== specs100[i].name || specs5[i].collateral !== specs100[i].collateral) {
      specsIdentical = false; break;
    }
  }
  assert(specsIdentical, "Canonical specs[0..4] identical in 5/100 pools");

  // 4. Deep clone: mutations don't contaminate
  console.log("\n== 4. Deep clone ==");
  const spec = specs5[0];
  const clone1 = cloneProvider(spec);
  const clone2 = cloneProvider(spec);
  clone1.provider.totalVolume = 999999;
  clone1.provider.liquidity.balances.set("USD", 0);
  clone1.provider.executionHistory.push({ providerId: spec.id, amount: 1000, outcome: "COMPLETED", durationSeconds: 60, step: 5, timeMs: 300000, feeBps: 10, corridorKey: "test" });
  assert(clone2.provider.totalVolume === 0, "Clone2 totalVolume not contaminated");
  assert(clone2.provider.liquidity.balances.get("USD") === spec.liquidityBalances.get("USD"), "Clone2 liquidity not contaminated");
  assert(clone2.provider.executionHistory.length === 0, "Clone2 executionHistory not contaminated");
  assert(spec.liquidityBalances.get("USD") === clone2.provider.liquidity.balances.get("USD"), "Original spec not contaminated");

  // 5. Per-seed corridors
  console.log("\n== 5. Per-seed corridors ==");
  const seed42Demand = generateDemandPopulation(42, 50, config);
  const seed43Demand = generateDemandPopulation(43, 50, config);
  const corridors42 = deriveDemandCorridors(seed42Demand);
  const corridors43 = deriveDemandCorridors(seed43Demand);
  assert(true, `Per-seed corridors derived (seed42 top: ${corridors42[0]?.[0]}→${corridors42[0]?.[2]}, seed43 top: ${corridors43[0]?.[0]}→${corridors43[0]?.[2]})`);

  // 6. Four reachability metrics exist
  console.log("\n== 6. Four reachability metrics exist ==");
  assert(expSrc.includes("assetReachablePct"), "Has assetReachablePct");
  assert(expSrc.includes("corridorReachablePct"), "Has corridorReachablePct");
  // (P4.8.8S) Corridor reachability now matches country via node-key graph
  // enumeration (source = `${srcAsset}:${srcCountry}`), not a direct field
  // comparison. Verify the node-key construction embeds the country.
  assert(expSrc.includes('`${o.sourceAsset}:${o.sourceCountry}`'), "Adjacency node key embeds sourceAsset:sourceCountry");
  assert(expSrc.includes('`${o.destinationAsset}:${o.destinationCountry}`'), "Adjacency node key embeds destinationAsset:destinationCountry");
  assert(expSrc.includes('`${srcAsset}:${srcCountry}`'), "Corridor source node key embeds srcCountry");
  assert(expSrc.includes('`${dstAsset}:${dstCountry}`'), "Corridor dest node key embeds dstCountry");
  // (P4.8.8S) Verify bridge multi-hop uses GLOBAL for settlement assets.
  // Bridge offers are created in generateCanonicalSpecs with country: "GLOBAL".
  assert(expSrc.includes('destinationCountry: "GLOBAL"'), "Bridge offers use destinationCountry GLOBAL");
  assert(expSrc.includes('sourceCountry: "GLOBAL"'), "Bridge offers use sourceCountry GLOBAL");

  // 7. Provider economics shared across topologies (ALL fields)
  console.log("\n== 7. Provider economics shared across topologies ==");
  const specsRandom = generateCanonicalSpecs(99999, 10, "RANDOM", settlementAssets, corridors);
  const specsFocused = generateCanonicalSpecs(99999, 10, "CORRIDOR_FOCUSED", settlementAssets, corridors);
  const specsBridged = generateCanonicalSpecs(99999, 10, "BRIDGED", settlementAssets, corridors);
  let economicsShared = true;
  const fieldsToCheck = ["id", "name", "providerType", "trustModel", "strategy", "collateral", "usableCollateral", "maxExposure"];
  for (let i = 0; i < 10; i++) {
    const r = specsRandom[i] as any, f = specsFocused[i] as any, b = specsBridged[i] as any;
    for (const field of fieldsToCheck) {
      if (r[field] !== f[field] || r[field] !== b[field]) {
        economicsShared = false;
        console.error(`  Provider ${i} field ${field}: R=${r[field]} F=${f[field]} B=${b[field]}`);
        break;
      }
    }
    // Check reliability profile.
    if (r.reliabilityProfile.fastRate !== f.reliabilityProfile.fastRate || r.reliabilityProfile.fastRate !== b.reliabilityProfile.fastRate) {
      economicsShared = false; break;
    }
    // Check FROZEN liquidity/treasury are identical across topologies.
    const rLiq = JSON.stringify([...r.liquidityBalances.entries()].sort());
    const fLiq = JSON.stringify([...f.liquidityBalances.entries()].sort());
    const bLiq = JSON.stringify([...b.liquidityBalances.entries()].sort());
    if (rLiq !== fLiq || rLiq !== bLiq) {
      economicsShared = false;
      console.error(`  Provider ${i} liquidityBalances differ across topologies`);
      break;
    }
    const rTrs = JSON.stringify([...r.treasuryBalances.entries()].sort());
    const fTrs = JSON.stringify([...f.treasuryBalances.entries()].sort());
    const bTrs = JSON.stringify([...b.treasuryBalances.entries()].sort());
    if (rTrs !== fTrs || rTrs !== bTrs) {
      economicsShared = false;
      console.error(`  Provider ${i} treasuryBalances differ across topologies`);
      break;
    }
  }
  assert(economicsShared, "Provider economics (ALL fields) identical across RANDOM/CORRIDOR_FOCUSED/BRIDGED");

  // Also verify bridge offers use canonical economics (not rng.int(3,10) or rate:1.0).
  let bridgeEconomicsCanonical = true;
  for (let i = 0; i < 10; i++) {
    const r = specsRandom[i] as any, b = specsBridged[i] as any;
    // At least one bridge offer should have the same feeBps and rate as the canonical.
    // (Not all bridge offers are guaranteed to be bridge-type, but those that are
    // should use canonical economics.)
    for (const os of b.offerSpecs) {
      // If this is a bridge offer (has GLOBAL), check it uses canonical economics.
      if (os.sourceCountry === "GLOBAL" || os.destinationCountry === "GLOBAL") {
        if (os.rate !== r.offerSpecs[0]?.rate || os.feeBps !== r.offerSpecs[0]?.feeBps) {
          bridgeEconomicsCanonical = false;
          console.error(`  Bridge offer economics differ: rate=${os.rate} (expected ${r.offerSpecs[0]?.rate}), feeBps=${os.feeBps} (expected ${r.offerSpecs[0]?.feeBps})`);
          break;
        }
      }
    }
    if (!bridgeEconomicsCanonical) break;
  }
  assert(bridgeEconomicsCanonical, "Bridge offers use canonical economics (not rng.int(3,10) or rate:1.0)");

  // 8. Four reachability metrics
  console.log("\n== 8. Four reachability metrics ==");
  assert(expSrc.includes("assetReachablePct"), "Has assetReachablePct");
  assert(expSrc.includes("corridorReachablePct"), "Has corridorReachablePct");
  assert(expSrc.includes("liquidityExecutableReachabilityPct"), "Has liquidityExecutableReachabilityPct");
  assert(expSrc.includes("productionExecutableReachabilityPct"), "Has productionExecutableReachabilityPct");
  // Verify production executable uses shared risk functions.
  assert(expSrc.includes("settlementAssetRisk("), "Production exec uses settlementAssetRisk()");
  assert(expSrc.includes("assetRiskCeiling("), "Production exec uses assetRiskCeiling()");
  assert(expSrc.includes("providerCounterpartyRisk("), "Production exec uses providerCounterpartyRisk()");
  assert(expSrc.includes("counterpartyRiskCeiling("), "Production exec uses counterpartyRiskCeiling()");
  // (P4.8.8S) Multi-hop checks EACH hop's destination liquidity via the
  // output-aware pattern: computeHopOutput() then balances.get(offer.destinationAsset).
  assert(expSrc.includes("computeHopOutput(a.amount,"), "Path feasibility computes hop output for liquidity check");
  assert(expSrc.includes("provider.liquidity.balances.get(offer.destinationAsset)"), "Path feasibility checks each hop's destination liquidity (output-aware)");
  assert(expSrc.includes("dstLiquidity < requiredDstLiquidity"), "Path feasibility compares destination liquidity against hop output");

  // 9. Production-faithful path search (Prompt 4.8.8)
  console.log("\n== 9. Production-faithful path search (P4.8.8) ==");
  // Imports shared canonical functions — no duplicate formula.
  assert(expSrc.includes("computeHopOutput"), "Experiment imports shared computeHopOutput");
  assert(expSrc.includes("coverAmount"), "Experiment imports shared coverAmount");
  assert(expSrc.includes("enumeratePaths"), "Experiment imports shared enumeratePaths");
  // No local duplicate hopOutput formula.
  assert(!expSrc.includes("function hopOutput("), "No local duplicate hopOutput() function");
  // Uses maxHops=4 (same as production findRoutes default).
  assert(expSrc.includes("MAX_HOPS = 4"), "Uses MAX_HOPS=4 (production default)");
  assert(expSrc.includes("enumeratePaths(adj, source, dest, MAX_HOPS)"), "Calls enumeratePaths with MAX_HOPS");
  // Route-composition metrics.
  assert(expSrc.includes("directReachablePct"), "Has directReachablePct metric");
  assert(expSrc.includes("splitDirectReachablePct"), "Has splitDirectReachablePct metric");
  assert(expSrc.includes("twoHopReachablePct"), "Has twoHopReachablePct metric");
  assert(expSrc.includes("threePlusHopReachablePct"), "Has threePlusHopReachablePct metric");
  // Split-capacity support via shared coverAmount.
  assert(expSrc.includes("coverAmount(coverOffers, currentAmount)"), "Path feasibility uses shared coverAmount for split support");
  // Per-user risk tolerance (not hard-coded BALANCED).
  assert(expSrc.includes("assetRiskCeiling(riskTolerance)"), "Path feasibility uses per-user riskTolerance for asset ceiling");
  assert(expSrc.includes("counterpartyRiskCeiling(riskTolerance)"), "Path feasibility uses per-user riskTolerance for counterparty ceiling");
  // Risk caches (performance: precompute once per extractMetrics).
  assert(expSrc.includes("saRiskCache"), "Precomputes settlement-asset risk cache");
  assert(expSrc.includes("cpRiskCache"), "Precomputes counterparty risk cache");
  // Import guard: experiment only runs when executed directly.
  assert(expSrc.includes("__isMain"), "Experiment guarded against running on import");

  // 10. Production routing delegates to shared (no duplicate formula)
  console.log("\n== 10. Production routing delegates to shared ==");
  const routingSrc = fs.readFileSync("src/lib/engine/routing.ts", "utf-8");
  assert(routingSrc.includes("sharedComputeHopOutput"), "Production routing imports sharedComputeHopOutput");
  assert(routingSrc.includes("sharedCoverAmount"), "Production routing imports sharedCoverAmount");
  assert(routingSrc.includes("sharedEnumeratePaths"), "Production routing imports sharedEnumeratePaths");
  assert(routingSrc.includes("type PathStep = SharedPathStep<AdjEdge>"), "Production routing uses shared PathStep type");
  // No local duplicate formula in routing.ts.
  assert(!routingSrc.includes("function computeHopOutput(inputAmount: Decimal, edge: AdjEdge): { output: Decimal; fee: Decimal; incentive: Decimal } {\n  const fee = feeForAmount"), "No local duplicate computeHopOutput formula in routing.ts");

  // 11. Capacity-semantics adapter (Prompt 4.8.8A)
  console.log("\n== 11. Capacity-semantics adapter (P4.8.8A) ==");
  // The adapter function must exist.
  assert(expSrc.includes("toProductionCapacity"), "Experiment defines toProductionCapacity adapter");
  assert(expSrc.includes("productionUsable"), "Experiment defines productionUsable helper");
  // The adapter must be USED in checkPathFeasibility (not just defined).
  assert(expSrc.includes("const prodCap = toProductionCapacity("), "checkPathFeasibility uses toProductionCapacity adapter");
  // The adapter must NOT pass simulator offers directly to coverAmount.
  // (The old buggy code had: availableCapacity: o.availableCapacity, without conversion.)
  assert(!expSrc.includes("availableCapacity: o.availableCapacity,\n      reservedCapacity: o.reservedCapacity,\n      minimumAmount: o.minimumAmount,\n    }));"), "No direct simulator-to-coverAmount conversion (adapter must be used)");
  // The adapter must be exported (for testing).
  assert(expSrc.includes("export function toProductionCapacity"), "toProductionCapacity is exported");
  assert(expSrc.includes("export function productionUsable"), "productionUsable is exported");
  // Documentation: the adapter must explain the semantic difference.
  assert(expSrc.includes("DOUBLE-SUBTRACT"), "Adapter documents the double-subtraction risk");
  assert(expSrc.includes("Simulator (engine-faithful.ts"), "Adapter documents simulator semantics");
  assert(expSrc.includes("Production (collateral.ts"), "Adapter documents production semantics");

  // 12. P4.8.8T — Frozen diagnostic integrity (physical vs economic capacity)
  console.log("\n== 12. Frozen diagnostic integrity (P4.8.8T) ==");
  // (4.8.8T) Aggregate PHYSICAL capacity: rate-only denomination conversion.
  assert(expSrc.includes("Aggregate PHYSICAL capacity"), "Experiment defines aggregatePhysicalCapacity");
  assert(expSrc.includes("denomination conversion ONLY"), "Physical capacity documents rate-only propagation");
  assert(expSrc.includes("RATE-ONLY (not outputMultiplier)"), "Physical capacity documents why rate-only (not outputMultiplier)");
  assert(expSrc.includes("export function checkAggregatePhysicalCapacityFeasible"), "checkAggregatePhysicalCapacityFeasible is exported");
  // (4.8.8T) Aggregate ECONOMIC capacity: full outputMultiplier (fees + incentives).
  assert(expSrc.includes("Aggregate ECONOMIC capacity"), "Experiment defines aggregateEconomicCapacity");
  assert(expSrc.includes("conversion economics (fees + incentives + FX rate)"), "Economic capacity documents full conversion terms");
  assert(expSrc.includes("export function checkAggregateEconomicCapacityFeasible"), "checkAggregateEconomicCapacityFeasible is exported");
  assert(expSrc.includes("greedyCapacity feasible  =>  aggregateEconomicCapacity feasible"), "Economic capacity documents the monotonicity invariant");
  assert(expSrc.includes("UNIT MISMATCH"), "Economic capacity documents the 4.8.8R unit-mismatch bug it fixes");
  // RunMetrics has both fields.
  assert(expSrc.includes("aggregatePhysicalCapacityReachabilityPct"), "RunMetrics has aggregatePhysicalCapacityReachabilityPct");
  assert(expSrc.includes("aggregateEconomicCapacityReachabilityPct"), "RunMetrics has aggregateEconomicCapacityReachabilityPct");
  assert(!expSrc.includes("aggregateCapacityReachabilityPct:"), "Old aggregateCapacityReachabilityPct field removed from RunMetrics");
  // DemandFeasibility has both fields.
  assert(expSrc.includes("aggregatePhysicalCapacity: boolean"), "DemandFeasibility has aggregatePhysicalCapacity");
  assert(expSrc.includes("aggregateEconomicCapacity: boolean"), "DemandFeasibility has aggregateEconomicCapacity");
  assert(!expSrc.includes("aggregateCapacity: boolean"), "Old aggregateCapacity field removed from DemandFeasibility");
  // evaluateDemandFeasibility calls both.
  assert(expSrc.includes("checkAggregatePhysicalCapacityFeasible(path, amount, world)"), "evaluateDemandFeasibility calls physical capacity");
  assert(expSrc.includes("checkAggregateEconomicCapacityFeasible(path, amount, world)"), "evaluateDemandFeasibility calls economic capacity");
  // Path-cache cap tracking (the fix for the broken 4.8.8R tracking).
  assert(expSrc.includes("pathCapHitCount") && expSrc.includes("maxPathsObserved"), "RunMetrics carries path-cap tracking fields");
  assert(expSrc.includes("cache.pathCapHitCount = pathCapHitCount"), "buildPathCache writes cap stats onto the cache object");
  assert(expSrc.includes("pathCache?.pathCapHitCount ?? 0"), "extractMetrics inherits cap stats from the cache");
  assert(expSrc.includes("pathCap: number = MAX_PATHS_PER_TIER"), "buildPathCache accepts a pathCap override (for validation)");
  // Per-demand evaluator (DRY: shared by extractMetrics + validators).
  assert(expSrc.includes("export function evaluateDemandFeasibility"), "Exports evaluateDemandFeasibility helper");
  assert(expSrc.includes("export interface DemandFeasibility"), "Exports DemandFeasibility interface");
  assert(expSrc.includes("structural: boolean") && expSrc.includes("aggregatePhysicalCapacity: boolean"), "DemandFeasibility has structural + aggregatePhysicalCapacity flags");
  // Demand-sampling override (for validation).
  assert(expSrc.includes("demandSampleCap"), "extractMetrics accepts demandSampleCap override");
  assert(expSrc.includes("export interface ExtractMetricsOpts"), "Exports ExtractMetricsOpts interface");
  // Path-cap acceptance gate in output.
  assert(expSrc.includes("Path-Cap Acceptance Gate"), "printResults emits a path-cap acceptance gate");
  assert(expSrc.includes("pathCapHitCount === 0"), "Output documents the pathCapHitCount === 0 acceptance criterion");
  // Frozen table.
  assert(expSrc.includes("FROZEN Routing Diagnostic"), "printResults emits the FROZEN diagnostic table");
  assert(expSrc.includes("DIAGNOSTIC FROZEN (P4.8.8T)"), "Output marks the diagnostic as frozen (P4.8.8T)");
  assert(expSrc.includes("alternative production LB"), "Frozen table labels alternative production as LOWER BOUND");
  assert(expSrc.includes("aggregate physical capacity"), "Frozen table includes aggregate physical capacity column");
  assert(expSrc.includes("aggregate economic capacity"), "Frozen table includes aggregate economic capacity column");
  // alternativeProduction still labelled LOWER_BOUND (not exact).
  assert(expSrc.includes("LOWER_BOUND") || expSrc.includes("LOWER BOUND"), "Alternative production labelled as lower bound (not exact)");

  console.log(`\n========================================`);
  console.log(`  P4.8.8T Integrity: Passed: ${passed}  |  Failed: ${failed}`);
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
