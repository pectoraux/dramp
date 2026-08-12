// Serialization — converts Prisma records (with Decimal fields) into plain
// JSON-safe objects for API responses.

import { Decimal } from "./money";

export function dec(v: Decimal | string | number | null | undefined): string {
  if (v === null || v === undefined) return "0";
  return new Decimal(v).toString();
}

export function num(v: Decimal | string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return new Decimal(v).toNumber();
}

export function serializeExecution(e: any) {
  return {
    id: e.id,
    intentId: e.intentId,
    attemptNumber: e.attemptNumber,
    status: e.status,
    commitmentStatus: e.commitmentStatus,
    selectedRouteId: e.selectedRouteId,
    referenceRouteId: e.referenceRouteId,
    selectedRoute: e.selectedRouteJson ? JSON.parse(e.selectedRouteJson) : null,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
    failureReason: e.failureReason,
    waitedSeconds: e.waitedSeconds,
    intent: e.intent ? serializeIntent(e.intent) : null,
    routes: e.routes ? e.routes.map(serializeRoute) : [],
    obligations: e.obligations ? e.obligations.map(serializeObligation) : [],
    legs: e.legs ? e.legs.map(serializeLeg) : [],
    reservations: e.reservations ? e.reservations.map((r: any) => ({ ...r, amount: dec(r.amount) })) : [],
    collateralLocks: e.collateralLocks ? e.collateralLocks.map((c: any) => ({ ...c, amount: dec(c.amount) })) : [],
  };
}

export function serializeIntent(i: any) {
  return {
    id: i.id,
    userId: i.userId,
    sourceAmount: dec(i.sourceAmount),
    sourceAsset: i.sourceAsset,
    sourceCountry: i.sourceCountry,
    destinationAsset: i.destinationAsset,
    destinationCountry: i.destinationCountry,
    minimumDestinationAmount: i.minimumDestinationAmount ? dec(i.minimumDestinationAmount) : null,
    maximumTotalCost: i.maximumTotalCost ? dec(i.maximumTotalCost) : null,
    targetRate: i.targetRate ? dec(i.targetRate) : null,
    riskTolerance: i.riskTolerance,
    executionPolicy: i.executionPolicy,
    maxWaitSeconds: i.maxWaitSeconds,
    cancellationPolicy: i.cancellationPolicy,
    allowedSettlementAssets: safeJson(i.allowedSettlementAssets),
    prohibitedSettlementAssets: safeJson(i.prohibitedSettlementAssets),
    status: i.status,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
  };
}

export function serializeRoute(r: any) {
  return {
    id: r.id,
    executionId: r.executionId,
    legCount: r.legCount,
    totalCost: dec(r.totalCost),
    effectiveCost: dec(r.effectiveCost),
    grossOutput: dec(r.grossOutput),
    netOutput: dec(r.netOutput),
    incentiveBps: r.incentiveBps,
    risk: {
      counterparty: r.riskCounterparty,
      settlementAsset: r.riskSettlementAsset,
      liquidity: r.riskLiquidity,
      operational: r.riskOperational,
      duration: r.riskDuration,
      composite: r.riskComposite,
    },
    expectedExecutionSeconds: r.expectedExecutionSeconds,
    explanation: r.explanation,
    tag: r.tag,
    status: r.status,
    splitRoute: r.splitRoute,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    legs: r.legs ? r.legs.map(serializeLeg) : [],
  };
}

export function serializeLeg(l: any) {
  return {
    id: l.id,
    routeId: l.routeId,
    executionId: l.executionId,
    providerId: l.providerId,
    provider: l.provider ? serializeProvider(l.provider) : null,
    offerId: l.offerId,
    offer: l.offer ? serializeOffer(l.offer) : null,
    sequence: l.sequence,
    role: l.role,
    amount: dec(l.amount),
    sourceAsset: l.sourceAsset,
    destinationAsset: l.destinationAsset,
    settlementAssetId: l.settlementAssetId,
    channelType: l.channelType,
    status: l.status,
    commitmentStatus: l.commitmentStatus,
    actorId: l.actorId,
    actorNote: l.actorNote,
    confirmedAt: l.confirmedAt,
  };
}

export function serializeProvider(p: any) {
  return {
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    trustModel: p.trustModel,
    capabilities: safeJson(p.capabilities),
    countries: safeJson(p.countries),
    reputationScore: p.reputationScore,
    status: p.status,
    vaultId: p.vaultId,
    vault: p.vault ? serializeVault(p.vault) : null,
    offers: p.offers ? p.offers.map(serializeOffer) : [],
    obligations: p.obligations ? p.obligations.map(serializeObligation) : [],
  };
}

// Public (redacted) view of a provider for ordinary USERs. Omits vault
// internals, reserved capacity, and obligations — competitively sensitive
// operational data that ordinary users should not see.
export function serializeProviderPublic(p: any) {
  return {
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    trustModel: p.trustModel,
    capabilities: safeJson(p.capabilities),
    countries: safeJson(p.countries),
    reputationScore: p.reputationScore,
    status: p.status,
    // Offers: public pricing/corridor info only (no reservedCapacity).
    offers: p.offers
      ? p.offers
          .filter((o: any) => o.active)
          .map((o: any) => ({
            id: o.id,
            capability: o.capability,
            sourceAsset: o.sourceAsset,
            destinationAsset: o.destinationAsset,
            sourceCountry: o.sourceCountry,
            destinationCountry: o.destinationCountry,
            rate: dec(o.rate),
            feeBps: o.feeBps,
            minimumAmount: dec(o.minimumAmount),
            maximumAmount: dec(o.maximumAmount),
            availableCapacity: dec(o.availableCapacity),
            settlementAssetId: o.settlementAssetId,
            channelType: o.channelType,
            expectedExecutionSeconds: o.expectedExecutionSeconds,
            incentiveBps: o.incentiveBps,
            active: o.active,
          }))
      : [],
    // No vault, no obligations, no reservedCapacity.
  };
}

export function serializeOffer(o: any) {
  return {
    id: o.id,
    providerId: o.providerId,
    provider: o.provider ? { id: o.provider.id, name: o.provider.name, providerType: o.provider.providerType, trustModel: o.provider.trustModel } : null,
    capability: o.capability,
    sourceAsset: o.sourceAsset,
    destinationAsset: o.destinationAsset,
    sourceCountry: o.sourceCountry,
    destinationCountry: o.destinationCountry,
    rate: dec(o.rate),
    feeBps: o.feeBps,
    minimumAmount: dec(o.minimumAmount),
    maximumAmount: dec(o.maximumAmount),
    availableCapacity: dec(o.availableCapacity),
    reservedCapacity: dec(o.reservedCapacity),
    settlementAssetId: o.settlementAssetId,
    channelType: o.channelType,
    expectedExecutionSeconds: o.expectedExecutionSeconds,
    incentiveBps: o.incentiveBps,
    active: o.active,
    expiresAt: o.expiresAt,
  };
}

export function serializeVault(v: any) {
  return {
    id: v.id,
    providerId: v.providerId,
    holdings: safeJson(v.holdingsJson),
    usableCollateral: dec(v.usableCollateral),
    lockedCollateral: dec(v.lockedCollateral),
    collateralizationRatio: v.collateralizationRatio,
    maxExposure: dec(v.maxExposure),
  };
}

export function serializeObligation(o: any) {
  return {
    id: o.id,
    executionId: o.executionId,
    legId: o.legId,
    providerId: o.providerId,
    provider: o.provider ? { id: o.provider.id, name: o.provider.name } : null,
    counterpartyProviderId: o.counterpartyProviderId,
    amount: dec(o.amount),
    asset: o.asset,
    collateralBackingId: o.collateralBackingId,
    dueAt: o.dueAt,
    status: o.status,
    createdAt: o.createdAt,
    fulfilledAt: o.fulfilledAt,
  };
}

export function serializeSettlementAsset(a: any) {
  return {
    id: a.id,
    symbol: a.symbol,
    issuer: a.issuer,
    assetType: a.assetType,
    network: a.network,
    volatilityScore: a.volatilityScore,
    liquidityScore: a.liquidityScore,
    pegQuality: a.pegQuality,
    redemptionModel: a.redemptionModel,
    incentiveRate: a.incentiveRate,
    incentiveSource: a.incentiveSource,
    settlementHaircut: a.settlementHaircut,
    collateralHaircut: a.collateralHaircut,
    isEligibleCollateral: a.isEligibleCollateral,
    maximumNetworkExposure: a.maximumNetworkExposure ? dec(a.maximumNetworkExposure) : null,
    status: a.status,
  };
}

export function serializeAuditEvent(e: any) {
  return {
    id: e.id,
    timestamp: e.timestamp,
    executionId: e.executionId,
    intentId: e.intentId,
    eventType: e.eventType,
    payload: safeJson(e.payloadJson),
    actorType: e.actorType,
    actorId: e.actorId,
    prevHash: e.prevHash,
    hash: e.hash,
  };
}

export function serializeLedgerEntry(l: any) {
  return {
    id: l.id,
    timestamp: l.timestamp,
    debitAccount: l.debitAccount,
    creditAccount: l.creditAccount,
    amount: dec(l.amount),
    asset: l.asset,
    entryType: l.entryType,
    executionId: l.executionId,
    obligationId: l.obligationId,
    description: l.description,
  };
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
