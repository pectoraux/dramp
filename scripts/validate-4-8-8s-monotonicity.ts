/**
 * dRamp Prompt 4.8.8S — Monotonicity Invariant Validator.
 *
 * Asserts for EVERY evaluated demand (no sampling) across:
 *   20 seeds × 3 topologies × density=100
 *
 * the monotonicity chain:
 *
 *   structural >= aggregateCapacity >= greedyCapacity >= greedyLiquidity >= greedyProduction
 *
 * (as booleans, where true >= false). Fails on ANY violation.
 *
 * Why this holds by construction:
 *   - greedyProduction feasible  => same path is greedyLiquidity feasible
 *     (production = liquidity + risk/minmax/status, all additive constraints)
 *   - greedyLiquidity feasible   => same path is greedyCapacity feasible
 *     (liquidity = capacity + dst-liquidity check)
 *   - greedyCapacity feasible    => same path is aggregateCapacity feasible
 *     (coverAmount's assignment uses a SUBSET of total usable capacity, so
 *      sum(usable) >= sum(assignment) >= amount  — the 4.8.8R invariant)
 *   - aggregateCapacity feasible => some path exists => structural feasible
 *
 * This validator EMPIRICALLY confirms the invariant across 60 worlds.
 *
 * Usage: bun scripts/validate-4-8-8s-monotonicity.ts
 */

import {
  generateDemandPopulation, deriveDemandCorridors, generateCanonicalSpecs,
  buildWorld, buildPathCache, buildFeasibilityContext, evaluateDemandFeasibility,
  makeConfig, makeSettlementAssets, EXPERIMENT_CONSTANTS,
} from "../experiments/p4-topology-experiment";
import type { SimWorld } from "../src/lib/simulator/world";

const { BASE_SEED, NUM_SEEDS, TOPOLOGIES, MAX_PATHS_PER_TIER } = EXPERIMENT_CONSTANTS;
const DENSITY = 100;

interface Violation {
  seed: number; topology: string; corridor: string; amount: number;
  structural: boolean; aggCap: boolean; greedyCap: boolean; greedyLiq: boolean; greedyProd: boolean;
  brokenEdge: string;
}

async function main() {
  console.log("dRamp P4.8.8S — Monotonicity Invariant Validator");
  console.log(`  ${NUM_SEEDS} seeds × ${TOPOLOGIES.length} topologies × density=${DENSITY} = ${NUM_SEEDS * TOPOLOGIES.length} worlds`);
  console.log(`  Every demand evaluated (no sampling). MAX_PATHS_PER_TIER=${MAX_PATHS_PER_TIER}.`);
  console.log("");

  const settlementAssets = makeSettlementAssets();
  const violations: Violation[] = [];
  let totalDemands = 0;
  let totalCapHits = 0;

  for (const topology of TOPOLOGIES) {
    let topoDemands = 0;
    let topoCapHits = 0;
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = BASE_SEED + s;
      const config = makeConfig(seed);
      const demandPopulation = generateDemandPopulation(seed, 50, config);
      const demandCorridors = deriveDemandCorridors(demandPopulation);
      const canonicalSpecs = generateCanonicalSpecs(seed + 99999, DENSITY, topology as any, settlementAssets, demandCorridors);
      const world: SimWorld = buildWorld(seed, DENSITY, topology as any, demandPopulation, canonicalSpecs, config);

      // Path cache (capped at MAX_PATHS_PER_TIER) + feasibility context.
      const pCache = buildPathCache(world);
      const ctx = buildFeasibilityContext(world);
      topoCapHits += pCache.pathCapHitCount ?? 0;

      // Collect demands per corridor (same grouping as extractMetrics).
      const corridorDemands = new Map<string, Array<{ amount: number; riskTolerance: string }>>();
      for (const u of world.users.values()) {
        const key = `${u.sourceAsset}:${u.sourceCountry}→${u.destinationAsset}:${u.destinationCountry}`;
        const arr = corridorDemands.get(key) ?? [];
        arr.push({ amount: u.typicalAmount, riskTolerance: u.riskTolerance });
        corridorDemands.set(key, arr);
      }

      for (const [corridorKey, demands] of corridorDemands) {
        const cached = pCache.get(corridorKey);
        if (!cached) continue; // no paths at all → structural=false for all; nothing to check
        for (const d of demands) {
          topoDemands++;
          const feas = evaluateDemandFeasibility(
            cached.hop1, cached.hop2, cached.hop3, cached.hop4,
            d.amount, d.riskTolerance, world, ctx.saRiskCache, ctx.cpRiskCache, true,
          );
          // Check the chain: structural >= aggCap >= greedyCap >= greedyLiq >= greedyProd
          if (feas.greedyProduction && !feas.greedyLiquidity) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggCap: feas.aggregateCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "greedyProd=true but greedyLiq=false" });
          }
          if (feas.greedyLiquidity && !feas.greedyCapacity) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggCap: feas.aggregateCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "greedyLiq=true but greedyCap=false" });
          }
          if (feas.greedyCapacity && !feas.aggregateCapacity) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggCap: feas.aggregateCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "greedyCap=true but aggCap=false" });
          }
          if (feas.aggregateCapacity && !feas.structural) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggCap: feas.aggregateCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "aggCap=true but structural=false" });
          }
        }
      }
    }
    totalDemands += topoDemands;
    totalCapHits += topoCapHits;
    console.log(`  ${topology}: ${topoDemands} demands checked, ${topoCapHits} path-cap hits`);
  }

  console.log("");
  console.log(`Total demands checked : ${totalDemands}`);
  console.log(`Total path-cap hits    : ${totalCapHits}`);
  console.log(`Monotonicity violations: ${violations.length}`);
  console.log("");
  if (violations.length > 0) {
    console.log("FAIL ✗ — monotonicity invariant violated:");
    for (const v of violations.slice(0, 20)) {
      console.log(`  seed=${v.seed} ${v.topology} ${v.corridor} amt=${v.amount} | ${v.brokenEdge}`);
      console.log(`    struct=${v.structural} aggCap=${v.aggCap} greedyCap=${v.greedyCap} greedyLiq=${v.greedyLiq} greedyProd=${v.greedyProd}`);
    }
    if (violations.length > 20) console.log(`  ... and ${violations.length - 20} more`);
    process.exit(1);
  }
  console.log("PASS ✓ — monotonicity invariant holds for every evaluated demand.");
  console.log("        structural >= aggregateCapacity >= greedyCapacity >= greedyLiquidity >= greedyProduction");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
