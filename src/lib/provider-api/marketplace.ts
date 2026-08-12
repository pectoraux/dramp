// Marketplace service — public liquidity view + anonymized pending demand.
//
// ARCHITECTURE RULE: this reads the EXISTING LiquidityOffer / ExecutionIntent
// tables. It does not create parallel liquidity data. Public views redact
// provider-private information (exact collateral, reserved capacity,
// obligations). Capacity is bucketed to avoid revealing sensitive demand.

import { db } from "@/lib/db";
import { Decimal } from "@/lib/engine/money";
import { providerCounterpartyRisk, providerRiskFromRecord } from "@/lib/engine/risk";

// ---- Public marketplace offers ------------------------------------------
// Returns active offers from ACTIVE providers, with public fields only.
// Exact reservedCapacity is replaced with a capacity bucket.
export async function getMarketplaceOffers(filter?: {
  sourceAsset?: string;
  destinationAsset?: string;
  sourceCountry?: string;
  destinationCountry?: string;
}): Promise<any[]> {
  const where: any = { active: true, provider: { status: "ACTIVE" } };
  if (filter?.sourceAsset) where.sourceAsset = filter.sourceAsset;
  if (filter?.destinationAsset) where.destinationAsset = filter.destinationAsset;
  if (filter?.sourceCountry) where.sourceCountry = filter.sourceCountry;
  if (filter?.destinationCountry) where.destinationCountry = filter.destinationCountry;

  const offers = await db.liquidityOffer.findMany({
    where,
    include: { provider: true },
    orderBy: { feeBps: "asc" },
    take: 200,
  });

  return offers.map((o) => ({
    id: o.id,
    provider: {
      id: o.provider.id,
      name: o.provider.name,
      providerType: o.provider.providerType,
      trustModel: o.provider.trustModel,
      reputationScore: o.provider.reputationScore,
    },
    capability: o.capability,
    sourceAsset: o.sourceAsset,
    destinationAsset: o.destinationAsset,
    sourceCountry: o.sourceCountry,
    destinationCountry: o.destinationCountry,
    rate: o.rate.toString(),
    feeBps: o.feeBps,
    incentiveBps: o.incentiveBps,
    // Public capacity bucket — not exact reservedCapacity.
    capacityBucket: bucketCapacity(new Decimal(o.availableCapacity).minus(new Decimal(o.reservedCapacity))),
    channelType: o.channelType,
    expectedExecutionSeconds: o.expectedExecutionSeconds,
    settlementAssetId: o.settlementAssetId,
    expiresAt: o.expiresAt,
    // Public risk indicator (counterparty risk only, not internal exposure).
    riskIndicator: Math.round(providerCounterpartyRisk(providerRiskFromRecord(o.provider)) * 100) / 100,
  }));
}

function bucketCapacity(available: Decimal): string {
  const n = available.toNumber();
  if (n <= 0) return "none";
  if (n < 1000) return "low";
  if (n < 10000) return "medium";
  if (n < 50000) return "high";
  return "deep";
}

// ---- Anonymized pending demand ------------------------------------------
// Returns active WAIT_FOR_BETTER intents, anonymized: no userId, no exact
// amount (bucketed), no destination identity beyond the corridor. This lets
// providers see demand they could satisfy without exposing user PII.
export async function getPendingDemand(): Promise<any[]> {
  const active = await db.executionIntent.findMany({
    where: {
      status: "ACTIVE",
      executionPolicy: "WAIT_FOR_BETTER",
      executions: { some: { status: "SEARCHING" } },
    },
    include: { executions: { where: { status: "SEARCHING" }, take: 1 } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const now = Date.now();
  return active.map((i) => {
    const exec = i.executions[0];
    const elapsed = exec ? Math.floor((now - exec.startedAt.getTime()) / 1000) : 0;
    const remaining = Math.max(0, i.maxWaitSeconds - elapsed);
    return {
      id: i.id, // intent id is safe to share (it's not a user id)
      sourceAsset: i.sourceAsset,
      destinationAsset: i.destinationAsset,
      sourceCountry: i.sourceCountry,
      destinationCountry: i.destinationCountry,
      amountBucket: bucketAmount(new Decimal(i.sourceAmount)),
      riskTolerance: i.riskTolerance,
      executionPolicy: i.executionPolicy,
      remainingWaitSeconds: remaining,
      elapsedSeconds: elapsed,
    };
  });
}

function bucketAmount(amount: Decimal): string {
  const n = amount.toNumber();
  if (n < 500) return "<500";
  if (n < 2000) return "500-2k";
  if (n < 10000) return "2k-10k";
  if (n < 50000) return "10k-50k";
  return "50k+";
}

// ---- Provider competition for a corridor --------------------------------
// Shows multiple providers competing for the same flow, with their route
// characteristics. Uses the existing routing engine's findRoutes.
export async function getProviderCompetition(input: {
  sourceAsset: string;
  sourceCountry: string;
  destinationAsset: string;
  destinationCountry: string;
  sourceAmount: string | number;
  riskTolerance?: string;
}): Promise<any[]> {
  const { findRoutes } = await import("@/lib/engine/routing");
  const candidates = await findRoutes({
    sourceAmount: input.sourceAmount,
    sourceAsset: input.sourceAsset,
    sourceCountry: input.sourceCountry,
    destinationAsset: input.destinationAsset,
    destinationCountry: input.destinationCountry,
    riskTolerance: input.riskTolerance ?? "BALANCED",
    allowedSettlementAssets: [],
    prohibitedSettlementAssets: [],
  });

  const providers = await db.liquidityProvider.findMany();
  const pMap = new Map(providers.map((p) => [p.id, p] as const));

  return candidates
    .filter((c) => !c.hardFilterRejection)
    .slice(0, 10)
    .map((c) => {
      const firstLeg = c.legs[0];
      const prov = firstLeg ? pMap.get(firstLeg.providerId) : null;
      return {
        tag: c.tag,
        providerName: prov?.name ?? "Unknown",
        providerType: prov?.providerType ?? "",
        trustModel: prov?.trustModel ?? "",
        effectiveCost: c.effectiveCost.toString(),
        netOutput: c.netOutput.toString(),
        expectedExecutionSeconds: c.expectedExecutionSeconds,
        hopCount: c.hopCount,
        risk: c.risk,
        explanation: c.explanation,
        legs: c.legs.map((l) => ({
          providerName: pMap.get(l.providerId)?.name ?? "Unknown",
          sourceAsset: l.sourceAsset,
          destinationAsset: l.destinationAsset,
          channelType: l.channelType,
          feeBps: l.feeBps,
          incentiveBps: l.incentiveBps,
        })),
      };
    });
}
