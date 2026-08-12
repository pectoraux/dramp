// Risk service — computes counterparty risk, settlement-asset risk, and the
// five separate route risk dimensions. Risk is NEVER collapsed into one opaque
// number internally; a composite is only derived for ranking.

import { db } from "@/lib/db";
import { Decimal } from "./money";
import {
  CHANNEL_TYPE,
  PROVIDER_TYPE,
  TRUST_MODEL,
} from "./types";

// ---- Provider counterparty risk (0..1, higher = riskier) -----------------

const TRUST_MODEL_BASE_RISK: Record<string, number> = {
  [TRUST_MODEL.COLLATERALIZED]: 0.15,
  [TRUST_MODEL.INSTITUTIONALLY_TRUSTED]: 0.1,
  [TRUST_MODEL.PRE_FUNDED]: 0.25,
  [TRUST_MODEL.EXTERNAL_ESCROW]: 0.3,
  [TRUST_MODEL.NON_CUSTODIAL]: 0.4,
};

const PROVIDER_TYPE_RISK_ADJUST: Record<string, number> = {
  [PROVIDER_TYPE.BANK]: -0.05,
  [PROVIDER_TYPE.PSP]: -0.02,
  [PROVIDER_TYPE.CEX]: 0.03,
  [PROVIDER_TYPE.DEX]: 0.08,
  [PROVIDER_TYPE.STABLECOIN_LP]: 0.02,
  [PROVIDER_TYPE.LOCAL_FIAT_AGENT]: 0.05,
  [PROVIDER_TYPE.MARKET_MAKER]: 0.04,
  [PROVIDER_TYPE.TREASURY]: -0.08,
  [PROVIDER_TYPE.SETTLEMENT_ASSET_SPONSOR]: 0.06,
  [PROVIDER_TYPE.HYBRID]: 0.0,
};

export interface ProviderRiskInput {
  trustModel: string;
  providerType: string;
  reputationScore: number; // 0..1 (1 = best)
  status: string;
  // optional historical signals (default 0 if absent)
  failureRate?: number; // 0..1
  disputeRate?: number; // 0..1
  operatingMonths?: number;
}

export function providerCounterpartyRisk(input: ProviderRiskInput): number {
  if (input.status !== "ACTIVE") return 1.0;
  let risk = TRUST_MODEL_BASE_RISK[input.trustModel] ?? 0.4;
  risk += PROVIDER_TYPE_RISK_ADJUST[input.providerType] ?? 0;
  // reputation: higher reputation lowers risk
  risk += (1 - (input.reputationScore ?? 0.5)) * 0.2;
  // failure / dispute history raises risk
  risk += (input.failureRate ?? 0) * 0.3;
  risk += (input.disputeRate ?? 0) * 0.2;
  // operating history: longer history lowers risk slightly
  const months = input.operatingMonths ?? 0;
  if (months > 0) risk -= Math.min(0.1, months / 1200);
  return clamp01(risk);
}

// ---- Settlement asset risk (0..1) ----------------------------------------

export interface SettlementAssetRiskInput {
  assetType: string;
  volatilityScore: number; // 0..1 (1 = very volatile)
  liquidityScore: number; // 0..1 (1 = deep liquidity)
  pegQuality: number | null; // 0..1 (1 = perfect peg) — null for non-stable
  status: string;
  incentiveRate: number; // bps — high incentive can be a sustainability red flag
}

export function settlementAssetRisk(input: SettlementAssetRiskInput): number {
  if (input.status !== "ACTIVE") return 1.0;
  let risk = 0;
  // Volatile tokens carry baseline settlement risk.
  if (input.assetType === "VOLATILE_TOKEN") risk += 0.35;
  // volatility contribution
  risk += input.volatilityScore * 0.3;
  // liquidity: low liquidity raises risk
  risk += (1 - input.liquidityScore) * 0.2;
  // peg quality: only meaningful for stablecoins
  if (input.assetType === "STABLECOIN") {
    const peg = input.pegQuality ?? 0.8;
    risk += (1 - peg) * 0.2;
  }
  // incentive sustainability: very high incentives raise risk
  if (input.incentiveRate > 40) risk += 0.1;
  if (input.incentiveRate > 80) risk += 0.1;
  return clamp01(risk);
}

// ---- Route risk dimensions ------------------------------------------------

export interface RouteLegRiskInput {
  provider: ProviderRiskInput;
  channelType: string; // AUTOMATIC | MANUAL
  offerCapacity: Decimal | string | number;
  legAmount: Decimal | string | number;
  settlementAsset?: SettlementAssetRiskInput;
  expectedExecutionSeconds: number;
}

export interface RouteRiskResult {
  counterparty: number;
  settlementAsset: number;
  liquidity: number;
  operational: number;
  duration: number;
  composite: number;
}

export function computeRouteRisk(legs: RouteLegRiskInput[]): RouteRiskResult {
  if (legs.length === 0) {
    return { counterparty: 1, settlementAsset: 1, liquidity: 1, operational: 1, duration: 1, composite: 1 };
  }
  // Counterparty: max across legs (a route is as risky as its riskiest provider)
  const counterparty = Math.max(...legs.map((l) => providerCounterpartyRisk(l.provider)));
  // Settlement asset: max across legs that carry a settlement asset
  const settlementLegs = legs.filter((l) => l.settlementAsset);
  const settlementAsset = settlementLegs.length
    ? Math.max(...settlementLegs.map((l) => settlementAssetRisk(l.settlementAsset!)))
    : 0.1;
  // Liquidity: based on the tightest capacity utilization across legs
  const liquidity = Math.max(
    ...legs.map((l) => {
      const cap = new Decimal(l.offerCapacity);
      const amt = new Decimal(l.legAmount);
      if (cap.lte(0)) return 1;
      const util = amt.dividedBy(cap);
      // utilization > 0.7 starts to raise liquidity risk sharply
      if (util.lte(0.3)) return 0.1;
      if (util.lte(0.5)) return 0.25;
      if (util.lte(0.7)) return 0.45;
      if (util.lte(0.9)) return 0.7;
      return 0.95;
    }),
  );
  // Operational: manual channels and more hops raise risk
  const manualLegs = legs.filter((l) => l.channelType === CHANNEL_TYPE.MANUAL).length;
  const operational = clamp01(0.1 + manualLegs * 0.2 + (legs.length - 1) * 0.05);
  // Duration: total expected seconds normalized
  const totalSeconds = legs.reduce((s, l) => s + l.expectedExecutionSeconds, 0);
  const duration = clamp01(totalSeconds / 600); // 10 min => 1.0
  // Composite (used only for ranking; raw dimensions are always stored)
  const composite = clamp01(
    counterparty * 0.3 + settlementAsset * 0.2 + liquidity * 0.2 + operational * 0.15 + duration * 0.15,
  );
  return { counterparty, settlementAsset, liquidity, operational, duration, composite };
}

// ---- Asset risk ceiling per user risk tolerance ---------------------------

export function assetRiskCeiling(riskTolerance: string): number {
  // The maximum settlement-asset risk a route may use given the user's tolerance.
  switch (riskTolerance) {
    case "MAX_RELIABILITY":
      return 0.25;
    case "BALANCED":
      return 0.5;
    case "LOWEST_COST":
      return 0.8;
    default:
      return 0.5;
  }
}

export function counterpartyRiskCeiling(riskTolerance: string): number {
  switch (riskTolerance) {
    case "MAX_RELIABILITY":
      return 0.3;
    case "BALANCED":
      return 0.55;
    case "LOWEST_COST":
      return 0.8;
    default:
      return 0.55;
  }
}

function clamp01(n: number): number {
  if (!isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

// Helper to load a provider's risk input from the DB record.
export function providerRiskFromRecord(p: {
  trustModel: string;
  providerType: string;
  reputationScore: number;
  status: string;
}): ProviderRiskInput {
  return {
    trustModel: p.trustModel,
    providerType: p.providerType,
    reputationScore: p.reputationScore,
    status: p.status,
  };
}

export function settlementAssetRiskFromRecord(a: {
  assetType: string;
  volatilityScore: number;
  liquidityScore: number;
  pegQuality: number | null;
  status: string;
  incentiveRate: number;
}): SettlementAssetRiskInput {
  return {
    assetType: a.assetType,
    volatilityScore: a.volatilityScore,
    liquidityScore: a.liquidityScore,
    pegQuality: a.pegQuality,
    status: a.status,
    incentiveRate: a.incentiveRate,
  };
}
