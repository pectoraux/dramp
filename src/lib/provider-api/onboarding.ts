// Provider onboarding service.
// ARCHITECTURE RULE: onboarding uses the EXISTING LiquidityProvider entity
// (extended with onboarding fields). No parallel provider registry.
//
// Lifecycle: APPLIED → REVIEW → APPROVED → ACTIVE → SUSPENDED
// A provider cannot publish active marketplace offers until status === ACTIVE.
// The routing engine already filters out non-ACTIVE providers.

import { db } from "@/lib/db";
import { appendAuditEvent } from "@/lib/engine/audit";
import { assertCollateralEligible } from "@/lib/engine/collateral";
import { Decimal } from "@/lib/engine/money";
import { TRUST_MODEL, PROVIDER_TYPE, SETTLEMENT_ASSET_TYPE } from "@/lib/engine/types";

export interface ProviderApplicationInput {
  name: string;
  providerType: string;
  trustModel: string;
  capabilities: string[];
  countries: string[];
  jurisdiction: string;
  contactEmail: string;
  supportedAssets: string[];
  settlementMethods: string[];
  reputationScore?: number;
  note?: string;
}

// Submit a provider application (public — any authenticated user can apply).
export async function submitProviderApplication(input: ProviderApplicationInput): Promise<{ id: string }> {
  const provider = await db.liquidityProvider.create({
    data: {
      name: input.name,
      providerType: input.providerType,
      trustModel: input.trustModel,
      capabilities: JSON.stringify(input.capabilities),
      countries: JSON.stringify(input.countries),
      reputationScore: input.reputationScore ?? 0.5,
      status: "APPLIED",
      jurisdiction: input.jurisdiction,
      contactEmail: input.contactEmail,
      supportedAssets: JSON.stringify(input.supportedAssets),
      settlementMethods: JSON.stringify(input.settlementMethods),
      apiIntegrationStatus: "NONE",
      onboardingNote: input.note ?? null,
    },
  });
  await appendAuditEvent({
    eventType: "provider_applied",
    payload: { providerId: provider.id, name: input.name, type: input.providerType, trustModel: input.trustModel },
    actorType: "USER",
  });
  return { id: provider.id };
}

// Move a provider through the lifecycle (admin only).
export async function updateProviderLifecycle(providerId: string, newStatus: string, adminId: string, note?: string): Promise<void> {
  const provider = await db.liquidityProvider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error("provider not found");

  await db.liquidityProvider.update({
    where: { id: providerId },
    data: {
      status: newStatus,
      onboardingNote: note ?? provider.onboardingNote,
      reviewedById: adminId,
      reviewedAt: new Date(),
    },
  });

  // When a collateralized provider is approved → ACTIVE, create a vault if none.
  if (newStatus === "ACTIVE" && provider.trustModel === TRUST_MODEL.COLLATERALIZED && !provider.vaultId) {
    const defaultCollateral = getDefaultCollateral(provider.providerType);
    const usdc = await db.settlementAsset.findUnique({ where: { symbol: "USDC" } });
    if (usdc) {
      assertCollateralEligible(usdc);
      const usable = new Decimal(defaultCollateral).times(1 - usdc.collateralHaircut);
      const ratio = 1.5;
      const maxExposure = usable.dividedBy(ratio);
      const vault = await db.vault.create({
        data: {
          providerId,
          holdingsJson: JSON.stringify([{ asset: "USDC", amount: defaultCollateral }]),
          usableCollateral: usable,
          lockedCollateral: new Decimal(0),
          collateralizationRatio: ratio,
          maxExposure,
        },
      });
      await db.liquidityProvider.update({ where: { id: providerId }, data: { vaultId: vault.id } });
    }
  }

  await appendAuditEvent({
    eventType: `provider_${newStatus.toLowerCase()}`,
    payload: { providerId, name: provider.name, newStatus, note },
    actorType: "USER",
    actorId: adminId,
  });
}

function getDefaultCollateral(providerType: string): number {
  switch (providerType) {
    case PROVIDER_TYPE.BANK: return 50000;
    case PROVIDER_TYPE.STABLECOIN_LP: return 40000;
    case PROVIDER_TYPE.LOCAL_FIAT_AGENT: return 20000;
    case PROVIDER_TYPE.PSP: return 15000;
    default: return 10000;
  }
}

// Get all providers with their onboarding state.
export async function getProvidersForReview() {
  return db.liquidityProvider.findMany({
    include: { vault: true, offers: true, operators: true },
    orderBy: { createdAt: "desc" },
  });
}
