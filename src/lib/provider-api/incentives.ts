// Incentive service — settlement-asset incentive campaigns.
//
// ARCHITECTURE RULE: this does NOT create a parallel pricing system. The
// routing engine already reads `offer.incentiveBps` and applies it to route
// economics. This service manages the CAMPAIGN lifecycle and the accounting
// so that:
//   - displayed incentives are "promised" (campaign budget remaining)
//   - earned incentives are "accrued" (only after a qualifying execution
//     COMPLETES)
//   - paid incentives are credited via the existing ledger
//
// ACCOUNTING SEMANTICS (Prompt 2.2):
//   totalBudget     — max total incentive the campaign will ever pay out
//   accrued         — cumulative incentive earned by completed executions
//   paid            — cumulative incentive actually disbursed (subset of accrued)
//   qualifiedVolume — cumulative settlement volume that earned incentives
//
//   remainingBudget = totalBudget - accrued
//   unpaidAccrued   = accrued - paid
//
// (paid is NOT an additional consumption of the budget — it is a disbursement
// of already-accrued earnings. Subtracting both accrued and paid from
// totalBudget would double-count paid incentives.)
//
// CONCURRENCY SAFETY (Prompt 2.1):
//   - IncentiveEarning has a @@unique([campaignId, executionId, providerId])
//     constraint, so duplicate accrual is prevented at the DB level.
//   - Budget + volume reservation happen inside a single transaction using
//     conditional updates (optimistic locking on `accrued` + `qualifiedVolume`),
//     so two concurrent completions cannot overspend a campaign.
//   - On unique-constraint violation, the earning already exists → skip.
//   - On conditional-update failure (another txn modified the campaign), retry.

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { Decimal, moneyAdd, moneyGte, moneyLte, moneyGt, moneyMin, bpsToFactor, incentiveForAmount } from "@/lib/engine/money";
import { appendAuditEvent } from "@/lib/engine/audit";

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 50;

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
    // Check budget remaining. Accounting semantics:
    //   accrued = cumulative incentive earned by completed executions
    //   paid    = cumulative incentive actually disbursed
    //   remainingBudget = totalBudget - accrued
    // (paid is a subset of accrued, not an additional consumption.)
    const remaining = new Decimal(c.totalBudget).minus(new Decimal(c.accrued));
    if (moneyLte(remaining, 0)) continue;
    // Check volume cap remaining.
    if (c.volumeCap) {
      const volRemaining = new Decimal(c.volumeCap).minus(new Decimal(c.qualifiedVolume));
      if (moneyLte(volRemaining, 0)) continue;
    }
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
//
// Concurrency-safe: each leg's earning is created inside a single transaction
// with a conditional update on the campaign's accrued+qualifiedVolume, plus a
// unique constraint that prevents duplicate (campaignId, executionId, providerId).
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

    // Try to accrue with retry on concurrency conflict.
    let accrued = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await tryAccrueLeg(campaignId, executionId, leg);
      if (result === "ACCRUED") { accrued = true; break; }
      if (result === "DUPLICATE") { accrued = false; break; } // already earned
      if (result === "SKIP") { accrued = false; break; } // budget/volume exhausted
      // result === "CONFLICT" → wait briefly and retry
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    if (!accrued) continue;

    await appendAuditEvent({
      executionId,
      eventType: "incentive_accrued",
      payload: { campaignId, providerId: leg.providerId, legId: leg.id },
      actorType: "SYSTEM",
    });
  }
}

type AccrueResult = "ACCRUED" | "DUPLICATE" | "SKIP" | "CONFLICT";

// Attempt to accrue a single leg's incentive inside one transaction.
// Uses conditional update on the campaign to prevent overspending.
async function tryAccrueLeg(campaignId: string, executionId: string, leg: any): Promise<AccrueResult> {
  try {
    return await db.$transaction(async (tx) => {
      // Re-fetch the campaign INSIDE the transaction.
      const campaign = await tx.settlementIncentiveCampaign.findUnique({ where: { id: campaignId } });
      if (!campaign || campaign.status !== "ACTIVE") return "SKIP";

      // Check date window.
      const now = new Date();
      if (now < campaign.startDate || now > campaign.endDate) return "SKIP";

      // Compute the qualifying volume (the leg's settlement amount).
      const legVolume = new Decimal(leg.amount);

      // Enforce volume cap.
      if (campaign.volumeCap) {
        const volRemaining = new Decimal(campaign.volumeCap).minus(new Decimal(campaign.qualifiedVolume));
        if (moneyLte(volRemaining, 0)) {
          await markExhausted(tx, campaignId);
          return "SKIP";
        }
        // If this leg's volume exceeds remaining volume cap, cap the qualifying
        // volume to what remains. The earning is proportional.
        if (moneyGt(legVolume, volRemaining)) {
          // Qualifying volume is capped; the incentive is computed on the
          // capped volume, not the full leg.
          return await accrueWithCappedVolume(tx, campaign, executionId, leg, volRemaining);
        }
      }

      // Compute the incentive amount on this leg's settlement volume.
      const incAmount = incentiveForAmount(legVolume, campaign.incentiveBps);
      if (moneyLte(incAmount, 0)) return "SKIP";

      // Enforce per-transaction cap.
      let amount = incAmount;
      if (campaign.perTxnCap && moneyGt(amount, campaign.perTxnCap)) {
        amount = new Decimal(campaign.perTxnCap);
      }

      // Enforce total budget remaining.
      // remainingBudget = totalBudget - accrued (paid is a subset of accrued).
      const budgetRemaining = new Decimal(campaign.totalBudget).minus(new Decimal(campaign.accrued));
      if (moneyLte(budgetRemaining, 0)) {
        await markExhausted(tx, campaignId);
        return "SKIP";
      }
      amount = moneyMin(amount, budgetRemaining);

      // Try to create the earning record. The unique constraint on
      // (campaignId, executionId, providerId) prevents duplicates.
      try {
        await tx.incentiveEarning.create({
          data: {
            campaignId,
            executionId,
            providerId: leg.providerId,
            amount,
            qualifiedVolume: legVolume,
            status: "ACCRUED",
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return "DUPLICATE"; // already earned for this (campaign, execution, provider)
        }
        throw e;
      }

      // Conditional update: only succeeds if accrued + qualifiedVolume haven't
      // changed since we read them (optimistic locking).
      const updated = await tx.settlementIncentiveCampaign.updateMany({
        where: {
          id: campaignId,
          accrued: new Decimal(campaign.accrued),
          qualifiedVolume: new Decimal(campaign.qualifiedVolume),
        },
        data: {
          accrued: moneyAdd(new Decimal(campaign.accrued), amount),
          qualifiedVolume: moneyAdd(new Decimal(campaign.qualifiedVolume), legVolume),
        },
      });
      if (updated.count === 0) {
        // Another transaction modified the campaign — abort and retry.
        throw new ConcurrencyConflictError();
      }

      // Check if budget is now exhausted.
      // remainingBudget = totalBudget - accrued (paid is a subset of accrued).
      const newRemaining = new Decimal(campaign.totalBudget).minus(moneyAdd(new Decimal(campaign.accrued), amount));
      if (moneyLte(newRemaining, 0)) {
        await markExhausted(tx, campaignId);
      }

      // Post an INCENTIVE ledger entry.
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

      return "ACCRUED";
    }, { timeout: 30000, maxWait: 15000 });
  } catch (e) {
    if (e instanceof ConcurrencyConflictError) return "CONFLICT";
    // Prisma unique constraint on the earning → duplicate
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "DUPLICATE";
    throw e;
  }
}

// Accrue with volume capped to the remaining volume-cap headroom.
async function accrueWithCappedVolume(tx: any, campaign: any, executionId: string, leg: any, cappedVolume: Decimal): Promise<AccrueResult> {
  // Pro-rate the incentive: the qualifying volume is capped, so the incentive
  // is computed on the capped volume.
  const incAmount = incentiveForAmount(cappedVolume, campaign.incentiveBps);
  if (moneyLte(incAmount, 0)) return "SKIP";

  let amount = incAmount;
  if (campaign.perTxnCap && moneyGt(amount, campaign.perTxnCap)) {
    amount = new Decimal(campaign.perTxnCap);
  }
  const budgetRemaining = new Decimal(campaign.totalBudget).minus(new Decimal(campaign.accrued));
  if (moneyLte(budgetRemaining, 0)) {
    await markExhausted(tx, campaign.id);
    return "SKIP";
  }
  amount = moneyMin(amount, budgetRemaining);

  try {
    await tx.incentiveEarning.create({
      data: {
        campaignId: campaign.id,
        executionId,
        providerId: leg.providerId,
        amount,
        qualifiedVolume: cappedVolume,
        status: "ACCRUED",
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "DUPLICATE";
    throw e;
  }

  const updated = await tx.settlementIncentiveCampaign.updateMany({
    where: {
      id: campaign.id,
      accrued: new Decimal(campaign.accrued),
      qualifiedVolume: new Decimal(campaign.qualifiedVolume),
    },
    data: {
      accrued: moneyAdd(new Decimal(campaign.accrued), amount),
      qualifiedVolume: moneyAdd(new Decimal(campaign.qualifiedVolume), cappedVolume),
    },
  });
  if (updated.count === 0) throw new ConcurrencyConflictError();

  await tx.ledgerEntry.create({
    data: {
      debitAccount: `dramp:incentives:${leg.destinationAsset}`,
      creditAccount: `provider:${leg.providerId}:operational:${leg.destinationAsset}`,
      amount,
      asset: leg.destinationAsset,
      entryType: "INCENTIVE",
      executionId,
      idempotencyKey: `incentive-campaign:${executionId}:${leg.id}:${campaign.id}`,
      description: `Campaign "${campaign.name}" incentive accrued (volume-capped)`,
    },
  });

  return "ACCRUED";
}

class ConcurrencyConflictError extends Error {}

async function markExhausted(tx: any, campaignId: string): Promise<void> {
  await tx.settlementIncentiveCampaign.updateMany({
    where: { id: campaignId, status: "ACTIVE" },
    data: { status: "EXHAUSTED" },
  });
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
      qualifiedVolume: new Decimal(0),
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
  // Accounting semantics:
  //   accrued        = cumulative incentive earned by completed executions
  //   paid           = cumulative incentive actually disbursed (subset of accrued)
  //   remainingBudget = totalBudget - accrued
  //   unpaidAccrued  = accrued - paid
  const remaining = budget.minus(accrued);
  const unpaidAccrued = accrued.minus(paid);
  const qualifiedVolume = new Decimal(c.qualifiedVolume);
  const volRemaining = c.volumeCap ? new Decimal(c.volumeCap).minus(qualifiedVolume) : null;
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
    unpaidAccrued: unpaidAccrued.toString(),
    volumeCap: c.volumeCap?.toString() ?? null,
    qualifiedVolume: qualifiedVolume.toString(),
    volumeRemaining: volRemaining?.toString() ?? null,
    status: c.status,
    earningCount: c.earnings.length,
    sponsor: c.sponsorProvider?.name ?? null,
  };
}
