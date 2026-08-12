// Incentive service — settlement-asset incentive campaigns.
//
// ARCHITECTURE RULE: this does NOT create a parallel pricing system. The
// routing engine already reads `offer.incentiveBps` and applies it to route
// economics. This service manages the CAMPAIGN lifecycle and the accounting
// (accrued on completion, paid on settlement) so that:
//   - displayed incentives are "promised" (campaign budget remaining)
//   - earned incentives are "accrued" (only after a qualifying execution
//     COMPLETES)
//   - paid incentives are credited via the existing ledger
//
// Campaign eligibility is enforced: corridor, risk level, provider type,
// per-transaction cap, volume cap, total budget, and date window.

import { db } from "@/lib/db";
import { Decimal, moneyAdd, moneyGte, moneyLte, moneyMin, bpsToFactor, incentiveForAmount } from "@/lib/engine/money";
import { appendAuditEvent } from "@/lib/engine/audit";
import { incentive as incentiveEntry } from "@/lib/engine/ledger";

// Find the best active campaign for a given settlement asset + corridor context.
// Returns the incentiveBps to apply, or 0 if none.
export async function getApplicableIncentiveBps(
  settlementAssetId: string,
  context: {
    sourceAsset: string;
    destinationAsset: string;
    riskTolerance: string;
    providerType: string;
  },
): Promise<{ bps: number; campaignId: string | null }> {
  const now = new Date();
  const campaigns = await db.settlementIncentiveCampaign.findMany({
    where: { settlementAssetId, status: "ACTIVE", startDate: { lte: now }, endDate: { gte: now } },
  });
  let bestBps = 0;
  let bestId: string | null = null;
  for (const c of campaigns) {
    if (!isCampaignEligible(c, context)) continue;
    // Check budget remaining.
    const remaining = new Decimal(c.totalBudget).minus(new Decimal(c.accrued)).minus(new Decimal(c.paid));
    if (moneyLte(remaining, 0)) continue;
    if (c.incentiveBps > bestBps) {
      bestBps = c.incentiveBps;
      bestId = c.id;
    }
  }
  return { bps: bestBps, campaignId: bestId };
}

function isCampaignEligible(c: any, ctx: { sourceAsset: string; destinationAsset: string; riskTolerance: string; providerType: string }): boolean {
  const corridors = c.eligibleCorridors ? (JSON.parse(c.eligibleCorridors) as string[]) : null;
  if (corridors && corridors.length > 0) {
    const key = `${ctx.sourceAsset}:${ctx.destinationAsset}`;
    if (!corridors.includes(key)) return false;
  }
  const risks = c.eligibleRiskLevels ? (JSON.parse(c.eligibleRiskLevels) as string[]) : null;
  if (risks && risks.length > 0 && !risks.includes(ctx.riskTolerance)) return false;
  const types = c.eligibleProviderTypes ? (JSON.parse(c.eligibleProviderTypes) as string[]) : null;
  if (types && types.length > 0 && !types.includes(ctx.providerType)) return false;
  return true;
}

// Accrue incentive earnings for a completed execution. Called from
// completeExecution (via a hook). This is the ONLY place incentives are
// "earned" — never at route display time.
export async function accrueIncentiveForExecution(executionId: string): Promise<void> {
  const execution = await db.execution.findUnique({
    where: { id: executionId },
    include: {
      intent: true,
      legs: { include: { provider: true, offer: true } },
    },
  });
  if (!execution || execution.status !== "COMPLETED") return;

  for (const leg of execution.legs) {
    if (!leg.offer.settlementAssetId) continue;
    const { campaignId } = await getApplicableIncentiveBps(leg.offer.settlementAssetId, {
      sourceAsset: leg.sourceAsset,
      destinationAsset: leg.destinationAsset,
      riskTolerance: execution.intent.riskTolerance,
      providerType: leg.provider.providerType,
    });
    if (!campaignId) continue;

    const campaign = await db.settlementIncentiveCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) continue;

    // Compute the incentive amount on this leg's settlement volume.
    const incAmount = incentiveForAmount(leg.amount, campaign.incentiveBps);
    if (moneyLte(incAmount, 0)) continue;

    // Enforce per-transaction cap.
    let amount = incAmount;
    if (campaign.perTxnCap && moneyGt(amount, campaign.perTxnCap)) {
      amount = new Decimal(campaign.perTxnCap);
    }

    // Enforce total budget remaining.
    const remaining = new Decimal(campaign.totalBudget).minus(new Decimal(campaign.accrued)).minus(new Decimal(campaign.paid));
    if (moneyLte(remaining, 0)) {
      // Budget exhausted — mark campaign EXHAUSTED.
      await db.settlementIncentiveCampaign.update({ where: { id: campaignId }, data: { status: "EXHAUSTED" } });
      continue;
    }
    amount = moneyMin(amount, remaining);

    // Create the earning record (idempotent: check if one already exists).
    const existing = await db.incentiveEarning.findFirst({
      where: { campaignId, executionId, providerId: leg.providerId },
    });
    if (existing) continue;

    await db.$transaction(async (tx) => {
      await tx.incentiveEarning.create({
        data: {
          campaignId,
          executionId,
          providerId: leg.providerId,
          amount,
          status: "ACCRUED",
        },
      });
      await tx.settlementIncentiveCampaign.update({
        where: { id: campaignId },
        data: { accrued: moneyAdd(new Decimal(campaign.accrued), amount) },
      });
      // Post an INCENTIVE ledger entry crediting the provider's operational account.
      await tx.ledgerEntry.create({
        data: {
          debitAccount: `dramp:incentives:${leg.destinationAsset}`,
          creditAccount: `provider:${leg.providerId}:operational:${leg.destinationAsset}`,
          amount,
          asset: leg.destinationAsset,
          entryType: "INCENTIVE",
          executionId,
          idempotencyKey: `incentive-campaign:${executionId}:${leg.id}:${campaignId}`,
          description: `Campaign "${campaign.name}" incentive accrued`,
        },
      });
    });

    await appendAuditEvent({
      executionId,
      eventType: "incentive_accrued",
      payload: { campaignId, campaignName: campaign.name, providerId: leg.providerId, amount: amount.toString(), asset: leg.destinationAsset },
      actorType: "SYSTEM",
    });
  }
}

// Create a new incentive campaign (admin or sponsor).
export async function createCampaign(input: {
  settlementAssetId: string;
  sponsorProviderId?: string;
  name: string;
  incentiveBps: number;
  fundingSource: string;
  startDate: Date;
  endDate: Date;
  totalBudget: Decimal | string | number;
  perTxnCap?: Decimal | string | number;
  volumeCap?: Decimal | string | number;
  eligibleCorridors?: string[];
  eligibleRiskLevels?: string[];
  eligibleProviderTypes?: string[];
}): Promise<{ id: string }> {
  const c = await db.settlementIncentiveCampaign.create({
    data: {
      settlementAssetId: input.settlementAssetId,
      sponsorProviderId: input.sponsorProviderId ?? null,
      name: input.name,
      incentiveBps: input.incentiveBps,
      fundingSource: input.fundingSource,
      startDate: input.startDate,
      endDate: input.endDate,
      totalBudget: new Decimal(input.totalBudget),
      perTxnCap: input.perTxnCap ? new Decimal(input.perTxnCap) : null,
      volumeCap: input.volumeCap ? new Decimal(input.volumeCap) : null,
      eligibleCorridors: input.eligibleCorridors ? JSON.stringify(input.eligibleCorridors) : null,
      eligibleRiskLevels: input.eligibleRiskLevels ? JSON.stringify(input.eligibleRiskLevels) : null,
      eligibleProviderTypes: input.eligibleProviderTypes ? JSON.stringify(input.eligibleProviderTypes) : null,
      status: "ACTIVE",
      accrued: new Decimal(0),
      paid: new Decimal(0),
    },
  });
  await appendAuditEvent({
    eventType: "incentive_campaign_created",
    payload: { campaignId: c.id, name: input.name, assetId: input.settlementAssetId, bps: input.incentiveBps, budget: input.totalBudget.toString() },
    actorType: "SYSTEM",
  });
  return { id: c.id };
}

// Get campaign stats for display.
export async function getCampaignStats(campaignId: string) {
  const c = await db.settlementIncentiveCampaign.findUnique({
    where: { id: campaignId },
    include: { settlementAsset: true, sponsorProvider: true, earnings: true },
  });
  if (!c) return null;
  const accrued = new Decimal(c.accrued);
  const paid = new Decimal(c.paid);
  const budget = new Decimal(c.totalBudget);
  const remaining = budget.minus(accrued).minus(paid);
  return {
    id: c.id,
    name: c.name,
    settlementAsset: c.settlementAsset.symbol,
    incentiveBps: c.incentiveBps,
    fundingSource: c.fundingSource,
    startDate: c.startDate,
    endDate: c.endDate,
    totalBudget: budget.toString(),
    accrued: accrued.toString(),
    paid: paid.toString(),
    remaining: remaining.toString(),
    status: c.status,
    earningCount: c.earnings.length,
    sponsor: c.sponsorProvider?.name ?? null,
  };
}

import { moneyGt } from "@/lib/engine/money";
