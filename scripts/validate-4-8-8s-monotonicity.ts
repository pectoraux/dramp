/**
 * dRamp Prompt 4.8.8T — Monotonicity Invariant Validator.
 *
 * Asserts for EVERY evaluated demand (no sampling) across:
 *   20 seeds × 3 topologies × density=100
 *
 * the monotonicity chain:
 *
 *   structural >= aggregateEconomicCapacity >= greedyCapacity >= greedyLiquidity >= greedyProduction
 *
 * (as booleans, where true >= false). Fails on ANY violation.
 *
 * (4.8.8T) aggregatePhysicalCapacity is NOT in the monotone chain — it has no
 * guaranteed ordering vs economic (depends on net fee/incentive balance).
 * It is tracked but not asserted.
 *
 * Why this holds by construction:
 *   - greedyProduction feasible  => same path is greedyLiquidity feasible
 *   - greedyLiquidity feasible   => same path is greedyCapacity feasible
 *   - greedyCapacity feasible    => same path is aggregateEconomicCapacity feasible
 *     (coverAmount's assignment uses a SUBSET of total usable capacity, and
 *      economic capacity propagates via min outputMultiplier <= greedy's mult)
 *   - aggregateEconomicCapacity feasible => some path exists => structural feasible
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
  structural: boolean; aggPhys: boolean; aggEcon: boolean; greedyCap: boolean; greedyLiq: boolean; greedyProd: boolean;
  brokenEdge: string;
}

async function main() {
  console.log("dRamp P4.8.8T — Monotonicity Invariant Validator");
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

      const pCache = buildPathCache(world);
      const ctx = buildFeasibilityContext(world);
      topoCapHits += pCache.pathCapHitCount ?? 0;

      const corridorDemands = new Map<string, Array<{ amount: number; riskTolerance: string }>>();
      for (const u of world.users.values()) {
        const key = `${u.sourceAsset}:${u.sourceCountry}→${u.destinationAsset}:${u.destinationCountry}`;
        const arr = corridorDemands.get(key) ?? [];
        arr.push({ amount: u.typicalAmount, riskTolerance: u.riskTolerance });
        corridorDemands.set(key, arr);
      }

      for (const [corridorKey, demands] of corridorDemands) {
        const cached = pCache.get(corridorKey);
        if (!cached) continue;
        for (const d of demands) {
          topoDemands++;
          const feas = evaluateDemandFeasibility(
            cached.hop1, cached.hop2, cached.hop3, cached.hop4,
            d.amount, d.riskTolerance, world, ctx.saRiskCache, ctx.cpRiskCache, true,
          );
          // Check the chain: structural >= aggEcon >= greedyCap >= greedyLiq >= greedyProd
          if (feas.greedyProduction && !feas.greedyLiquidity) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggPhys: feas.aggregatePhysicalCapacity, aggEcon: feas.aggregateEconomicCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "greedyProd=true but greedyLiq=false" });
          }
          if (feas.greedyLiquidity && !feas.greedyCapacity) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggPhys: feas.aggregatePhysicalCapacity, aggEcon: feas.aggregateEconomicCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "greedyLiq=true but greedyCap=false" });
          }
          if (feas.greedyCapacity && !feas.aggregateEconomicCapacity) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggPhys: feas.aggregatePhysicalCapacity, aggEcon: feas.aggregateEconomicCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "greedyCap=true but aggEcon=false" });
          }
          if (feas.aggregateEconomicCapacity && !feas.structural) {
            violations.push({ seed, topology, corridor: corridorKey, amount: d.amount, structural: feas.structural, aggPhys: feas.aggregatePhysicalCapacity, aggEcon: feas.aggregateEconomicCapacity, greedyCap: feas.greedyCapacity, greedyLiq: feas.greedyLiquidity, greedyProd: feas.greedyProduction, brokenEdge: "aggEcon=true but structural=false" });
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
      console.log(`    struct=${v.structural} aggPhys=${v.aggPhys} aggEcon=${v.aggEcon} greedyCap=${v.greedyCap} greedyLiq=${v.greedyLiq} greedyProd=${v.greedyProd}`);
    }
    if (violations.length > 20) console.log(`  ... and ${violations.length - 20} more`);
    process.exit(1);
  }
  console.log("PASS ✓ — monotonicity invariant holds for every evaluated demand.");
  console.log("        structural >= aggregateEconomicCapacity >= greedyCapacity >= greedyLiquidity >= greedyProduction");
  console.log("        (aggregatePhysicalCapacity is tracked but NOT in the chain — no guaranteed ordering vs economic)");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
