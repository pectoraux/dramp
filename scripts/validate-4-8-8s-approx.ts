/**
 * dRamp Prompt 4.8.8S — Path-Enumeration Approximation Validator.
 *
 * Proves the optimized path cache (capped at MAX_PATHS_PER_TIER=10000) produces
 * IDENTICAL metrics to uncapped path enumeration for:
 *
 *   20 seeds × 3 topologies × density=100
 *
 * Method:
 *   1. Build the capped cache for all 60 worlds. buildPathCache runs the FULL
 *      enumeratePaths DFS (no enumeration cap — only storage is sliced) and
 *      records pathCapHitCount (tiers whose path count > cap) + maxPathsObserved.
 *   2. If pathCapHitCount === 0 for a world, the slice was a NO-OP — the capped
 *      cache stores every path enumeratePaths found. So capped == uncapped BY
 *      CONSTRUCTION. No metric can differ.
 *   3. For EMPIRICAL verification, a direct uncapped-vs-cached metric comparison
 *      is run on a subset (first 5 seeds × 3 topologies = 15 worlds) where both
 *      caches are built and all five metrics are compared with zero tolerance.
 *
 * Compares: structural, aggregateCapacity, greedyCapacity, greedyLiquidity, greedyProduction.
 * REQUIRES zero disagreement. If any metric differs, the 10000-cap is truncating
 * paths and cached metrics are lower bounds (not exact).
 *
 * Usage: bun scripts/validate-4-8-8s-approx.ts
 */

import {
  generateDemandPopulation, deriveDemandCorridors, generateCanonicalSpecs,
  buildWorld, buildPathCache, extractMetrics,
  makeConfig, makeSettlementAssets, EXPERIMENT_CONSTANTS,
} from "../experiments/p4-topology-experiment";
import type { SimWorld } from "../src/lib/simulator/world";

const { BASE_SEED, NUM_SEEDS, TOPOLOGIES, MAX_PATHS_PER_TIER } = EXPERIMENT_CONSTANTS;
const DENSITY = 100;
// Direct comparison subset for empirical verification.
const EMPIRICAL_SEEDS = 5;

const METRIC_KEYS = [
  "corridorReachablePct",
  "aggregatePhysicalCapacityReachabilityPct",
  "aggregateEconomicCapacityReachabilityPct",
  "capacityExecutableReachabilityPct",
  "liquidityExecutableReachabilityPct",
  "productionExecutableReachabilityPct",
] as const;
type MetricKey = typeof METRIC_KEYS[number];

interface Disagreement {
  seed: number; topology: string; metric: MetricKey;
  capped: number; uncapped: number;
}

function buildWorldFor(seed: number, topology: string, settlementAssets: ReturnType<typeof makeSettlementAssets>): SimWorld {
  const config = makeConfig(seed);
  const demandPopulation = generateDemandPopulation(seed, 50, config);
  const demandCorridors = deriveDemandCorridors(demandPopulation);
  const canonicalSpecs = generateCanonicalSpecs(seed + 99999, DENSITY, topology as any, settlementAssets, demandCorridors);
  return buildWorld(seed, DENSITY, topology as any, demandPopulation, canonicalSpecs, config);
}

async function main() {
  console.log("dRamp P4.8.8S — Path-Enumeration Approximation Validator");
  console.log(`  ${NUM_SEEDS} seeds × ${TOPOLOGIES.length} topologies × density=${DENSITY} = ${NUM_SEEDS * TOPOLOGIES.length} worlds`);
  console.log(`  Capped cache (MAX_PATHS_PER_TIER=${MAX_PATHS_PER_TIER}) vs uncapped (Infinity).`);
  console.log("");

  const settlementAssets = makeSettlementAssets();
  const disagreements: Disagreement[] = [];
  let globalMaxPaths = 0;
  let globalCapHits = 0;
  let worldsExact = 0;

  // Phase 1: Build capped cache for ALL worlds. pathCapHitCount === 0 proves
  // capped == uncapped by construction (the slice was a no-op).
  console.log("Phase 1: Capped-cache acceptance across all 60 worlds...");
  for (const topology of TOPOLOGIES) {
    let topoCapHits = 0;
    let topoMaxPaths = 0;
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = BASE_SEED + s;
      const world = buildWorldFor(seed, topology, settlementAssets);
      const cappedCache = buildPathCache(world, MAX_PATHS_PER_TIER);
      const hits = cappedCache.pathCapHitCount ?? 0;
      const maxP = cappedCache.maxPathsObserved ?? 0;
      topoCapHits += hits;
      topoMaxPaths = Math.max(topoMaxPaths, maxP);
      if (hits === 0) worldsExact++;
    }
    globalCapHits += topoCapHits;
    globalMaxPaths = Math.max(globalMaxPaths, topoMaxPaths);
    console.log(`  ${topology}: ${topoCapHits} cap-hits, max paths in any tier = ${topoMaxPaths}`);
  }

  // Phase 2: Direct empirical comparison on a subset (uncapped vs capped metrics).
  console.log(`\nPhase 2: Direct uncapped-vs-capped metric comparison (${EMPIRICAL_SEEDS} seeds × ${TOPOLOGIES.length} topologies)...`);
  for (const topology of TOPOLOGIES) {
    for (let s = 0; s < EMPIRICAL_SEEDS; s++) {
      const seed = BASE_SEED + s;
      const world = buildWorldFor(seed, topology, settlementAssets);
      const cappedCache = buildPathCache(world, MAX_PATHS_PER_TIER);
      const uncappedCache = buildPathCache(world, Infinity);
      const mCapped = extractMetrics(world, "full", cappedCache);
      const mUncapped = extractMetrics(world, "full", uncappedCache);
      for (const key of METRIC_KEYS) {
        const c = mCapped[key] as number;
        const u = mUncapped[key] as number;
        if (Math.abs(c - u) > 1e-9) {
          disagreements.push({ seed, topology, metric: key, capped: c, uncapped: u });
        }
      }
    }
    process.stderr.write(`  Empirical comparison done: ${topology}\n`);
  }

  console.log("");
  console.log(`Phase 1 — pathCapHitCount === 0 : ${worldsExact} / ${NUM_SEEDS * TOPOLOGIES.length} worlds (capped == uncapped by construction)`);
  console.log(`Global max paths observed         : ${globalMaxPaths}`);
  console.log(`Global path-cap hits              : ${globalCapHits}`);
  console.log(`Phase 2 — direct metric disagreements : ${disagreements.length} (across ${EMPIRICAL_SEEDS * TOPOLOGIES.length} worlds)`);
  console.log("");

  if (globalCapHits > 0) {
    console.log(`FAIL ✗ — ${globalCapHits} path-cap hits. Capped cache truncated paths in ${NUM_SEEDS * TOPOLOGIES.length - worldsExact} worlds.`);
    console.log("        Path-dependent metrics are LOWER BOUNDS, not exact.");
    process.exit(1);
  }
  if (disagreements.length > 0) {
    console.log("FAIL ✗ — capped cache disagrees with uncapped enumeration (empirical):");
    for (const d of disagreements.slice(0, 20)) {
      console.log(`  seed=${d.seed} ${d.topology} ${d.metric}: capped=${d.capped} vs uncapped=${d.uncapped}`);
    }
    process.exit(1);
  }
  console.log("PASS ✓ — capped cache (10000) == uncapped enumeration.");
  console.log(`        pathCapHitCount === 0 for all ${NUM_SEEDS * TOPOLOGIES.length} worlds (Phase 1).`);
  console.log(`        Zero metric disagreement on ${EMPIRICAL_SEEDS * TOPOLOGIES.length} direct comparisons (Phase 2).`);
  console.log(`        Max paths observed in any tier: ${globalMaxPaths} (cap is ${MAX_PATHS_PER_TIER}).`);
  console.log("        Path-dependent metrics are EXACT (no truncation).");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
