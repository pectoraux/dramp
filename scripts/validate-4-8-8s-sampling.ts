/**
 * dRamp Prompt 4.8.8S — Demand-Sampling Approximation Validator.
 *
 * Compares the production demand-sampling (MAX_DEMANDS_FULL=8 per corridor)
 * against EXACT all-demand evaluation (demandSampleCap=Infinity) for:
 *
 *   20 seeds × 3 topologies × density=100
 *
 * Method:
 *   1. For ALL 60 worlds, check whether any corridor has > MAX_DEMANDS_FULL
 *      demands. If none do, sampling is a NO-OP (the `demands.length <= maxSample`
 *      branch fires for every corridor), so sampled == exact BY CONSTRUCTION.
 *   2. For EMPIRICAL verification, run the full extractMetrics comparison
 *      (sampled vs exact) on a subset (first 5 seeds × 3 topologies = 15 worlds).
 *
 * Reports, separately for each of the five metrics:
 *   - max absolute error
 *   - max relative error
 *   - mean absolute error
 *
 * Metrics: structural, aggregateCapacity, greedyCapacity, greedyLiquidity, greedyProduction
 *
 * Usage: bun scripts/validate-4-8-8s-sampling.ts
 */

import {
  generateDemandPopulation, deriveDemandCorridors, generateCanonicalSpecs,
  buildWorld, buildPathCache, extractMetrics,
  makeConfig, makeSettlementAssets, EXPERIMENT_CONSTANTS,
} from "../experiments/p4-topology-experiment";
import type { SimWorld } from "../src/lib/simulator/world";

const { BASE_SEED, NUM_SEEDS, TOPOLOGIES, MAX_DEMANDS_FULL } = EXPERIMENT_CONSTANTS;
const DENSITY = 100;
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

interface MetricStats { maxAbs: number; maxRel: number; meanAbs: number; count: number; }

function buildWorldFor(seed: number, topology: string, settlementAssets: ReturnType<typeof makeSettlementAssets>): SimWorld {
  const config = makeConfig(seed);
  const demandPopulation = generateDemandPopulation(seed, 50, config);
  const demandCorridors = deriveDemandCorridors(demandPopulation);
  const canonicalSpecs = generateCanonicalSpecs(seed + 99999, DENSITY, topology as any, settlementAssets, demandCorridors);
  return buildWorld(seed, DENSITY, topology as any, demandPopulation, canonicalSpecs, config);
}

async function main() {
  console.log("dRamp P4.8.8S — Demand-Sampling Approximation Validator");
  console.log(`  ${NUM_SEEDS} seeds × ${TOPOLOGIES.length} topologies × density=${DENSITY} = ${NUM_SEEDS * TOPOLOGIES.length} worlds`);
  console.log(`  Sampled (MAX_DEMANDS_FULL=${MAX_DEMANDS_FULL}) vs exact (all demands).`);
  console.log("");

  const settlementAssets = makeSettlementAssets();

  // Phase 1: Check the no-sampling condition for ALL 60 worlds.
  // If no corridor has > MAX_DEMANDS_FULL demands, the sampling branch never
  // activates, so sampled == exact by construction.
  console.log(`Phase 1: No-sampling condition across all ${NUM_SEEDS * TOPOLOGIES.length} worlds...`);
  let globalMaxDemandsPerCorridor = 0;
  let worldsNeedingSampling = 0;
  for (const topology of TOPOLOGIES) {
    let topoMaxDpc = 0;
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = BASE_SEED + s;
      const world = buildWorldFor(seed, topology, settlementAssets);
      const corridorCounts = new Map<string, number>();
      for (const u of world.users.values()) {
        const k = `${u.sourceAsset}:${u.sourceCountry}→${u.destinationAsset}:${u.destinationCountry}`;
        corridorCounts.set(k, (corridorCounts.get(k) ?? 0) + 1);
      }
      const maxDpc = Math.max(...corridorCounts.values());
      topoMaxDpc = Math.max(topoMaxDpc, maxDpc);
      if (maxDpc > MAX_DEMANDS_FULL) worldsNeedingSampling++;
    }
    globalMaxDemandsPerCorridor = Math.max(globalMaxDemandsPerCorridor, topoMaxDpc);
    console.log(`  ${topology}: max demands/corridor = ${topoMaxDpc} (sampling threshold = ${MAX_DEMANDS_FULL})`);
  }

  // Phase 2: Direct sampled-vs-exact metric comparison on a subset.
  console.log(`\nPhase 2: Direct sampled-vs-exact metric comparison (${EMPIRICAL_SEEDS} seeds × ${TOPOLOGIES.length} topologies)...`);
  const stats: Record<MetricKey, MetricStats> = {
    corridorReachablePct: { maxAbs: 0, maxRel: 0, meanAbs: 0, count: 0 },
    aggregatePhysicalCapacityReachabilityPct: { maxAbs: 0, maxRel: 0, meanAbs: 0, count: 0 },
    aggregateEconomicCapacityReachabilityPct: { maxAbs: 0, maxRel: 0, meanAbs: 0, count: 0 },
    capacityExecutableReachabilityPct: { maxAbs: 0, maxRel: 0, meanAbs: 0, count: 0 },
    liquidityExecutableReachabilityPct: { maxAbs: 0, maxRel: 0, meanAbs: 0, count: 0 },
    productionExecutableReachabilityPct: { maxAbs: 0, maxRel: 0, meanAbs: 0, count: 0 },
  };
  const absSums: Record<MetricKey, number> = {
    corridorReachablePct: 0,
    aggregatePhysicalCapacityReachabilityPct: 0,
    aggregateEconomicCapacityReachabilityPct: 0,
    capacityExecutableReachabilityPct: 0,
    liquidityExecutableReachabilityPct: 0,
    productionExecutableReachabilityPct: 0,
  };
  let empiricalCount = 0;
  for (const topology of TOPOLOGIES) {
    for (let s = 0; s < EMPIRICAL_SEEDS; s++) {
      const seed = BASE_SEED + s;
      const world = buildWorldFor(seed, topology, settlementAssets);
      const pCache = buildPathCache(world);
      const mSampled = extractMetrics(world, "full", pCache);
      const mExact = extractMetrics(world, "full", pCache, { demandSampleCap: Infinity });
      for (const key of METRIC_KEYS) {
        const samp = mSampled[key] as number;
        const exact = mExact[key] as number;
        const absErr = Math.abs(samp - exact);
        const relErr = exact !== 0 ? absErr / Math.abs(exact) : (absErr > 0 ? Infinity : 0);
        const st = stats[key];
        if (absErr > st.maxAbs) st.maxAbs = absErr;
        if (relErr > st.maxRel) st.maxRel = relErr;
        absSums[key] += absErr;
        st.count++;
      }
      empiricalCount++;
    }
    process.stderr.write(`  Empirical comparison done: ${topology}\n`);
  }
  for (const key of METRIC_KEYS) {
    stats[key].meanAbs = absSums[key] / empiricalCount;
  }

  console.log("");
  console.log("### Demand-Sampling Error (sampled vs exact)\n");
  console.log(`Phase 1: max demands/corridor across all ${NUM_SEEDS * TOPOLOGIES.length} worlds = ${globalMaxDemandsPerCorridor}`);
  console.log(`         (sampling threshold = ${MAX_DEMANDS_FULL}; worlds needing sampling = ${worldsNeedingSampling})`);
  console.log("");
  console.log(`Phase 2: direct metric comparison on ${empiricalCount} worlds\n`);
  console.log("| metric | max abs error (pp) | max rel error (%) | mean abs error (pp) |");
  console.log("| --- | --- | --- | --- |");
  for (const key of METRIC_KEYS) {
    const st = stats[key];
    console.log(`| ${key} | ${st.maxAbs.toFixed(6)} | ${(st.maxRel * 100).toFixed(6)} | ${st.meanAbs.toFixed(6)} |`);
  }
  console.log("");

  const anyError = METRIC_KEYS.some(k => stats[k].maxAbs > 1e-9);
  if (worldsNeedingSampling > 0) {
    console.log(`NOTE: ${worldsNeedingSampling} worlds have corridors with > ${MAX_DEMANDS_FULL} demands.`);
    console.log("      Sampling IS active for those corridors. The error bound above applies.");
    if (anyError) {
      const worstMaxAbs = Math.max(...METRIC_KEYS.map(k => stats[k].maxAbs));
      console.log(`      Reported bound: max abs error = ${worstMaxAbs.toFixed(4)} pp.`);
    }
    process.exit(0);
  }
  if (anyError) {
    console.log("NOTE: demand-sampling introduces non-zero error despite no corridor exceeding the threshold.");
    console.log("      This should not happen — investigate.");
    process.exit(1);
  }
  console.log("PASS ✓ — zero sampling error.");
  console.log(`        Max demands/corridor = ${globalMaxDemandsPerCorridor} <= ${MAX_DEMANDS_FULL} (threshold) for all ${NUM_SEEDS * TOPOLOGIES.length} worlds.`);
  console.log("        Sampling is a NO-OP — sampled percentages == exact percentages.");
  console.log("        The 8-demand sampling is lossless for these graph/demand sizes.");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
