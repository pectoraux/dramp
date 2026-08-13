// SimulationWorldAdapter — wraps a SimWorld and exposes it as a WorldSnapshot
// (the same shape that ProductionWorldAdapter produces). This lets the shared
// pure economic functions operate against either world identically.
//
// Used by:
//   - engine-faithful.ts (route discovery + execution)
//   - equivalence tests (same inputs → same outputs vs production)

import type { WorldSnapshot, ProviderInfo, OfferInfo, SettlementAssetInfo } from "@/lib/economics/world-adapter";
import type { SimWorld, SimProvider, SimOffer, SimSettlementAsset } from "./world";
import {
  providerCounterpartyRisk,
  settlementAssetRisk,
  type ProviderRiskInfo,
  type SettlementAssetRiskInput,
} from "@/lib/economics/shared";

export function simProviderToProviderInfo(p: SimProvider): ProviderInfo {
  const risk: ProviderRiskInfo = {
    trustModel: p.trustModel,
    providerType: p.providerType,
    reputationScore: p.reputationScore,
    status: p.status,
  };
  return {
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    trustModel: p.trustModel,
    reputationScore: p.reputationScore,
    status: p.status,
    risk,
  };
}

export function simOfferToOfferInfo(o: SimOffer): OfferInfo {
  return {
    id: o.id,
    providerId: o.providerId,
    capability: o.capability,
    sourceAsset: o.sourceAsset,
    destinationAsset: o.destinationAsset,
    sourceCountry: o.sourceCountry,
    destinationCountry: o.destinationCountry,
    rate: o.rate,
    feeBps: o.feeBps,
    minimumAmount: o.minimumAmount,
    maximumAmount: o.maximumAmount,
    availableCapacity: o.availableCapacity,
    reservedCapacity: o.reservedCapacity,
    settlementAssetId: o.settlementAssetId,
    channelType: o.channelType,
    expectedExecutionSeconds: o.expectedExecutionSeconds,
    incentiveBps: o.incentiveBps,
    active: o.active,
    version: o.version,
  };
}

export function simAssetToAssetInfo(a: SimSettlementAsset): SettlementAssetInfo {
  const risk: SettlementAssetRiskInput = {
    assetType: a.assetType,
    volatilityScore: a.volatilityScore,
    liquidityScore: a.liquidityScore,
    pegQuality: a.pegQuality,
    status: a.status,
    incentiveRate: a.incentiveRate,
  };
  return {
    id: a.id,
    symbol: a.symbol,
    assetType: a.assetType,
    volatilityScore: a.volatilityScore,
    liquidityScore: a.liquidityScore,
    pegQuality: a.pegQuality,
    incentiveRate: a.incentiveRate,
    collateralHaircut: a.collateralHaircut,
    isEligibleCollateral: a.isEligibleCollateral,
    status: a.status,
    risk,
  };
}

export function getSimWorldSnapshot(world: SimWorld): WorldSnapshot {
  const providers = new Map<string, ProviderInfo>();
  for (const p of world.providers.values()) {
    if (p.status === "ACTIVE") {
      providers.set(p.id, simProviderToProviderInfo(p));
    }
  }

  const offers: OfferInfo[] = [];
  for (const o of world.offers.values()) {
    if (o.active) offers.push(simOfferToOfferInfo(o));
  }

  const settlementAssets = new Map<string, SettlementAssetInfo>();
  for (const a of world.assets.values()) {
    settlementAssets.set(a.id, simAssetToAssetInfo(a));
  }

  // Reputation + corridor + commitment maps are built by the engine using
  // shared.calculateReputation. The adapter just exposes the raw data.
  return {
    providers,
    offers,
    settlementAssets,
    reputationMap: new Map(),        // filled by engine from execution history
    corridorScores: new Map(),       // filled by engine from corridor stats
    commitmentReliability: new Map(), // filled by engine from commitment data
    networkMedianFeeBps: calculateNetworkMedianFee(world),
  };
}

function calculateNetworkMedianFee(world: SimWorld): number {
  const fees = [...world.offers.values()].filter(o => o.active).map(o => o.feeBps).sort((a, b) => a - b);
  return fees.length > 0 ? fees[Math.floor(fees.length / 2)] : 20;
}

// Re-export the shared risk functions for convenience (the engine uses them
// directly via the shared module, but tests may want them from here too).
export { providerCounterpartyRisk, settlementAssetRisk };
