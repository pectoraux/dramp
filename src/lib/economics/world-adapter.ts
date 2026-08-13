// World Adapter — a common data interface that both production and simulation
// implement, so that the shared route engine can operate against either world.
//
// The adapter provides plain-number snapshots of:
//   - providers (with risk inputs)
//   - offers (with economics + capacity)
//   - settlement assets (with risk inputs)
//   - reputation map (providerId → 0..1)
//   - corridor score map (providerId:src:dst:srcCtry:dstCtry → 0..1)
//   - commitment reliability map (providerId → 0..1)
//   - network median fee (bps)
//
// Production wraps DB queries; simulation wraps SimWorld. Both produce the
// same shape, so the shared pure functions (rankRoutes, applyHardFilters,
// calculateAbsoluteRouteQuality, etc.) work identically against either.

import type {
  ProviderRiskInfo,
  SettlementAssetRiskInput,
} from "@/lib/economics/shared";

export interface ProviderInfo {
  id: string;
  name: string;
  providerType: string;
  trustModel: string;
  reputationScore: number; // 0..1
  status: string;
  risk: ProviderRiskInfo;
}

export interface OfferInfo {
  id: string;
  providerId: string;
  capability: string;
  sourceAsset: string;
  destinationAsset: string;
  sourceCountry: string;
  destinationCountry: string;
  rate: number;
  feeBps: number;
  minimumAmount: number;
  maximumAmount: number;
  availableCapacity: number;
  reservedCapacity: number;
  settlementAssetId: string | null;
  channelType: string;
  expectedExecutionSeconds: number;
  incentiveBps: number;
  active: boolean;
  version: number;
}

export interface SettlementAssetInfo {
  id: string;
  symbol: string;
  assetType: string;
  volatilityScore: number;
  liquidityScore: number;
  pegQuality: number | null;
  incentiveRate: number;
  collateralHaircut: number;
  isEligibleCollateral: boolean;
  status: string;
  risk: SettlementAssetRiskInput;
}

export interface IntentInfo {
  sourceAmount: number;
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  riskTolerance: string;
  allowedSettlementAssets: string[];
  prohibitedSettlementAssets: string[];
  maxHops?: number;
}

export interface WorldSnapshot {
  providers: Map<string, ProviderInfo>;
  offers: OfferInfo[];
  settlementAssets: Map<string, SettlementAssetInfo>;
  reputationMap: Map<string, number>;
  corridorScores: Map<string, number>;
  commitmentReliability: Map<string, number>;
  networkMedianFeeBps: number;
}

// Synchronous adapter interface. Production implements it by pre-loading all
// data into memory (a snapshot); simulation reads directly from SimWorld.
export interface WorldAdapter {
  snapshot(): WorldSnapshot;
}
