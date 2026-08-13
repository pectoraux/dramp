// Risk service — thin production wrapper around the canonical pure economics.
//
// ARCHITECTURE: all pure risk calculations live in src/lib/economics/shared.ts.
// This module provides DB-record adapters (providerRiskFromRecord,
// settlementAssetRiskFromRecord) and a Decimal-aware computeRouteRisk wrapper
// that delegates to the shared pure function after converting Decimal → number.
//
// No formula is duplicated here. If you find yourself adding a risk formula,
// add it to shared.ts instead.

import { Decimal } from "./money";
import {
  providerCounterpartyRisk as sharedProviderCounterpartyRisk,
  settlementAssetRisk as sharedSettlementAssetRisk,
  computeRouteRisk as sharedComputeRouteRisk,
  assetRiskCeiling as sharedAssetRiskCeiling,
  counterpartyRiskCeiling as sharedCounterpartyRiskCeiling,
  type ProviderRiskInfo,
  type SettlementAssetRiskInput,
  type RouteLegRiskInfo,
  type RouteRiskResult,
} from "@/lib/economics/shared";

// Re-export the canonical functions so existing imports continue to work.
export {
  sharedProviderCounterpartyRisk as providerCounterpartyRisk,
  sharedSettlementAssetRisk as settlementAssetRisk,
  sharedAssetRiskCeiling as assetRiskCeiling,
  sharedCounterpartyRiskCeiling as counterpartyRiskCeiling,
};
export type { ProviderRiskInfo as ProviderRiskInput, SettlementAssetRiskInput } from "@/lib/economics/shared";

// ---- DB-record adapters (production-specific) ----------------------------

export function providerRiskFromRecord(p: {
  trustModel: string;
  providerType: string;
  reputationScore: number;
  status: string;
}): ProviderRiskInfo {
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

// ---- Decimal-aware route risk wrapper -----------------------------------
//
// Production uses Decimal for money. The shared pure function uses number.
// We convert at the boundary — the risk thresholds (0.3, 0.5, 0.7, 0.9) are
// coarse enough that float64 precision is more than sufficient.

export interface RouteLegRiskInput {
  provider: ProviderRiskInfo;
  channelType: string;
  offerCapacity: Decimal | string | number;
  legAmount: Decimal | string | number;
  settlementAsset?: SettlementAssetRiskInput;
  expectedExecutionSeconds: number;
}

export function computeRouteRisk(legs: RouteLegRiskInput[]): RouteRiskResult {
  const sharedLegs: RouteLegRiskInfo[] = legs.map((l) => ({
    provider: l.provider,
    channelType: l.channelType,
    offerCapacity: new Decimal(l.offerCapacity).toNumber(),
    legAmount: new Decimal(l.legAmount).toNumber(),
    settlementAsset: l.settlementAsset,
    expectedExecutionSeconds: l.expectedExecutionSeconds,
  }));
  return sharedComputeRouteRisk(sharedLegs);
}

export type { RouteRiskResult } from "@/lib/economics/shared";
