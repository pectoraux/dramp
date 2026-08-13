import { NextResponse } from "next/server";
import { createDefaultConfig } from "@/lib/simulator/world";
import { requireAdmin, isAuthed } from "@/lib/auth-guard";

export async function GET() {
  const auth = await requireAdmin();
  if (!isAuthed(auth)) return auth.error;

  const defaultConfig = createDefaultConfig();

  const scenarios = [
    {
      id: "provider-growth",
      name: "Provider Growth (5→50)",
      description: "Start with 5 providers, grow to 50. Does more liquidity improve user outcomes?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 5, providerGrowthRate: 0.15 },
    },
    {
      id: "provider-exit",
      name: "Largest Provider Exit",
      description: "Remove the largest provider at step 50. How resilient is the network?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, shockType: "PROVIDER_EXIT", shockStep: 50, shockMagnitude: 0.5 },
    },
    {
      id: "stablecoin-incentive",
      name: "Stablecoin Incentive Bootstrap",
      description: "EURC 40bps incentive. Does it bootstrap adoption? Does volume survive after expiry?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, enableIncentives: true, shockType: "INCENTIVE_END", shockStep: 60 },
    },
    {
      id: "volatile-asset",
      name: "Volatile Settlement Asset",
      description: "WETH offers attractive economics. Do risk limits prevent unsafe routing?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25 },
    },
    {
      id: "patient-execution",
      name: "Patient Execution Comparison",
      description: "Compare NOW vs WAIT_FOR_BETTER. Is waiting economically valuable?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, policyDistribution: { now: 0.5, waitForBetter: 0.5 } },
    },
    {
      id: "liquidity-shock",
      name: "Liquidity Shock (50% removal)",
      description: "Remove 50% of liquidity at step 50. What happens to costs and completion?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, shockType: "LIQUIDITY", shockStep: 50, shockMagnitude: 0.5 },
    },
    {
      id: "demand-surge",
      name: "Demand Surge (5×)",
      description: "Demand increases 5× at step 50. Can the network handle it?",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, shockType: "DEMAND_SURGE", shockStep: 50, shockMagnitude: 4.0 },
    },
    {
      id: "no-incentives",
      name: "No Incentives (Baseline)",
      description: "Run without any incentive campaigns. Compare with incentivized scenarios.",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, enableIncentives: false },
    },
    {
      id: "no-reputation",
      name: "Reputation Disabled",
      description: "Run without reputation affecting routing. Compare with reputation enabled.",
      config: { ...defaultConfig, seed: 42, totalSteps: 100, initialProviders: 25, enableReputation: false },
    },
  ];

  return NextResponse.json({ scenarios, defaultConfig });
}
