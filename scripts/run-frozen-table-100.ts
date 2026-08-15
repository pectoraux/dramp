/**
 * dRamp Prompt 4.8.8S — Focused density=100 experiment for the final frozen table.
 *
 * Runs 20 seeds × 3 topologies at density=100 only (60 runs), saving results
 * incrementally to a JSON file after each seed. This avoids the memory
 * accumulation that kills the full 300-run experiment at the 50-provider tier.
 *
 * The full 5-density experiment (experiments/p4-topology-experiment.ts) is
 * still the canonical script; this is a resilient subset for the final table.
 *
 * Usage: bun scripts/run-frozen-table-100.ts
 */

import {
  generateDemandPopulation, deriveDemandCorridors, generateCanonicalSpecs,
  buildWorld, buildPathCache, extractMetrics, makeConfig, makeSettlementAssets,
  EXPERIMENT_CONSTANTS,
} from "../experiments/p4-topology-experiment";
import { simulateStep } from "../src/lib/simulator/engine-faithful";
import { SeededRNG } from "../src/lib/simulator/rng";
import type { SimWorld, SimSettlementAsset } from "../src/lib/simulator/world";
import * as fs from "fs";

const { BASE_SEED, NUM_SEEDS, TOPOLOGIES } = EXPERIMENT_CONSTANTS;
const DENSITY = 100;
const OUTPUT_FILE = "/home/z/my-project/frozen-table-results.json";

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
}

async function main() {
  console.log("dRamp P4.8.8S — Focused density=100 experiment for the frozen table");
  console.log(`  ${NUM_SEEDS} seeds × ${TOPOLOGIES.length} topologies × density=${DENSITY} = ${NUM_SEEDS * TOPOLOGIES.length} runs`);
  console.log("");

  const settlementAssets = makeSettlementAssets();
  // Resume capability: load existing results so multiple runs can complete
  // the full set (the sandbox kills long-running processes after ~60-90s).
  let results: Record<string, any[]> = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      results = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf-8"));
      const counts = TOPOLOGIES.map(t => `${t}:${results[t]?.length ?? 0}`).join(" ");
      console.log(`Resuming from saved results (${counts})`);
    } catch { results = {}; }
  }
  for (const t of TOPOLOGIES) if (!results[t]) results[t] = [];

  for (const topology of TOPOLOGIES) {
    const completedSeeds = new Set(results[topology].map((r: any) => r.seed));
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = BASE_SEED + s;
      if (completedSeeds.has(seed)) continue; // skip already-done seeds
      const config = makeConfig(seed);
      const demandPopulation = generateDemandPopulation(seed, 50, config);
      const demandCorridors = deriveDemandCorridors(demandPopulation);
      const canonicalSpecs = generateCanonicalSpecs(seed + 99999, DENSITY, topology as any, settlementAssets as Map<string, SimSettlementAsset>, demandCorridors);
      const world: SimWorld = buildWorld(seed, DENSITY, topology as any, demandPopulation, canonicalSpecs, config);

      const pCache = buildPathCache(world);
      const initialMetrics = extractMetrics(world, "full", pCache);

      const rng = new SeededRNG(seed);
      for (let step = 0; step < config.totalSteps; step++) {
        simulateStep(world, rng);
      }
      const finalMetrics = extractMetrics(world, "full", pCache);

      results[topology].push({
        seed,
        structural: finalMetrics.corridorReachablePct,
        aggregateCapacity: finalMetrics.aggregateCapacityReachabilityPct,
        greedyCapacity: finalMetrics.capacityExecutableReachabilityPct,
        greedyLiquidity: finalMetrics.liquidityExecutableReachabilityPct,
        greedyProduction: finalMetrics.productionExecutableReachabilityPct,
        alternativeProduction: finalMetrics.alternativeProductionExecutableReachabilityPct,
        inventory: finalMetrics.inventoryExecutableReachabilityPct,
        completion: finalMetrics.completionRate,
        pathCapHitCount: finalMetrics.pathCapHitCount,
        maxPathsObserved: finalMetrics.maxPathsObserved,
        initial: {
          structural: initialMetrics.corridorReachablePct,
          aggregateCapacity: initialMetrics.aggregateCapacityReachabilityPct,
          greedyCapacity: initialMetrics.capacityExecutableReachabilityPct,
          greedyLiquidity: initialMetrics.liquidityExecutableReachabilityPct,
          greedyProduction: initialMetrics.productionExecutableReachabilityPct,
          alternativeProduction: initialMetrics.alternativeProductionExecutableReachabilityPct,
        },
      });

      // Save incrementally after each seed (resilient to kills).
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

      // Force GC if available (reduces memory accumulation).
      if (global.gc) global.gc();

      process.stderr.write(`  ${topology} seed ${s + 1}/${NUM_SEEDS} done (capHits=${finalMetrics.pathCapHitCount})\n`);
    }
    console.log(`  Done: ${topology} (${results[topology].length}/${NUM_SEEDS} seeds)`);
  }

  // Check completion — only print the final table when all 60 seeds are done.
  const totalDone = TOPOLOGIES.reduce((s, t) => s + results[t].length, 0);
  if (totalDone < NUM_SEEDS * TOPOLOGIES.length) {
    console.log(`\nProgress: ${totalDone}/${NUM_SEEDS * TOPOLOGIES.length} seeds done. Re-run to continue.`);
    process.exit(0);
  }

  // Produce the final table.
  console.log("\n╔═══════════════════════════════════════════════════════════════════════╗");
  console.log("║  dRamp P4.8.8S — FROZEN Routing Diagnostic (density=100, 20 seeds)  ║");
  console.log("╚═══════════════════════════════════════════════════════════════════════╝");

  // Path-cap acceptance.
  const allCapHits = TOPOLOGIES.flatMap(t => results[t].map(r => r.pathCapHitCount));
  const totalCapHits = allCapHits.reduce((s, v) => s + v, 0);
  const globalMaxPaths = TOPOLOGIES.flatMap(t => results[t].map(r => r.maxPathsObserved)).reduce((mx, v) => Math.max(mx, v), 0);
  console.log("\n### Path-Cap Acceptance Gate\n");
  console.log(`  Total cap hits : ${totalCapHits}`);
  console.log(`  Max paths observed : ${globalMaxPaths} (cap = 10000)`);
  console.log(`  ACCEPTANCE: ${totalCapHits === 0 ? "PASS ✓ — metrics are EXACT" : "FAIL ✗ — metrics are LOWER BOUNDS"}`);

  // Monotonicity check (per-seed, on medians).
  console.log("\n### Monotonicity Check (medians per topology)\n");
  for (const t of TOPOLOGIES) {
    const ms = results[t];
    const medStruct = percentile(ms.map(r => r.structural), 0.5);
    const medAgg = percentile(ms.map(r => r.aggregateCapacity), 0.5);
    const medCap = percentile(ms.map(r => r.greedyCapacity), 0.5);
    const medLiq = percentile(ms.map(r => r.greedyLiquidity), 0.5);
    const medProd = percentile(ms.map(r => r.greedyProduction), 0.5);
    const mono = medStruct >= medAgg && medAgg >= medCap && medCap >= medLiq && medLiq >= medProd;
    console.log(`  ${t}: ${medStruct.toFixed(1)} >= ${medAgg.toFixed(1)} >= ${medCap.toFixed(1)} >= ${medLiq.toFixed(1)} >= ${medProd.toFixed(1)} → ${mono ? "✓" : "✗ VIOLATION"}`);
  }

  // Final frozen table.
  console.log("\n### Table F — FROZEN Routing Diagnostic (P4.8.8S) — density=100, 20 seeds\n");
  console.log("Medians (10th–90th percentile). Demand-weighted % of reachable volume.");
  console.log("Invariant: structural ≥ aggregateCapacity ≥ greedyCapacity ≥ greedyLiquidity ≥ greedyProduction");
  console.log("alternativeProduction = LOWER_BOUND (solver not proven exhaustive for 3+ offer multi-hop).\n");
  console.log("| topology | structural | aggregate capacity | greedy capacity | greedy liquidity | greedy production | alternative production LB |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of TOPOLOGIES) {
    const ms = results[t];
    const fmt = (key: string) => {
      const arr = ms.map(r => r[key]);
      return `${percentile(arr, 0.5).toFixed(1)} (${percentile(arr, 0.1).toFixed(1)}–${percentile(arr, 0.9).toFixed(1)})`;
    };
    console.log(`| ${t} | ${fmt("structural")} | ${fmt("aggregateCapacity")} | ${fmt("greedyCapacity")} | ${fmt("greedyLiquidity")} | ${fmt("greedyProduction")} | ${fmt("alternativeProduction")} |`);
  }
  console.log("\n>>> DIAGNOSTIC FROZEN (P4.8.8S). No further routing-experiment changes. <<<");
  console.log(`\nResults saved to ${OUTPUT_FILE}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
