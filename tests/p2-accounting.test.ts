/**
 * dRamp Prompt 2.2 — incentive accounting semantics + concurrent accrual
 * + partial-slash collateral release tests.
 *
 * Proves:
 *   1. Budget accounting is correct: remainingBudget = totalBudget - accrued
 *      (paid is NOT subtracted — it's a subset of accrued, not additional consumption).
 *   2. Concurrent accrual against a tight budget cannot overspend (optimistic locking
 *      + unique constraint). Multiple parallel accruals result in accrued <= totalBudget.
 *   3. Concurrent accrual against a tight volumeCap cannot exceed the cap.
 *   4. Partial slash releases the un-slashed portion of locked collateral back to available.
 *
 * These tests hit the DB directly (via Prisma) to exercise the real transaction logic,
 * not just the API surface. Requires a running, seeded server + DATABASE_URL.
 *
 * Usage: DATABASE_URL=... bun tests/p2-accounting.test.ts
 */

import { Decimal } from "../src/lib/engine/money";
import { db } from "../src/lib/db";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log("dRamp P2.2 accounting + concurrency tests (direct DB)");

  // ---- Setup: create a test settlement asset + campaign ----
  console.log("\n== Setup ==");
  const asset = await db.settlementAsset.upsert({
    where: { symbol: "TEST_USDC" },
    update: {},
    create: {
      symbol: "TEST_USDC",
      issuer: "Test",
      assetType: "STABLECOIN",
      network: "Test",
      volatilityScore: 0.02,
      liquidityScore: 0.95,
      pegQuality: 0.99,
      redemptionModel: "test",
      incentiveRate: 0,
      settlementHaircut: 0,
      collateralHaircut: 0.05,
      isEligibleCollateral: true,
      status: "ACTIVE",
    },
  });

  // Create a test user for the FK constraint.
  const testUser = await db.user.upsert({
    where: { email: "test-accounting@dramp.test" },
    update: {},
    create: { email: "test-accounting@dramp.test", name: "Test Accounting", role: "USER", status: "ACTIVE" },
  });

  // =========================================================================
  // 1. BUDGET ACCOUNTING SEMANTICS
  // =========================================================================
  console.log("\n== 1. Budget accounting: remaining = totalBudget - accrued ==");

  const campaign = await db.settlementIncentiveCampaign.create({
    data: {
      settlementAssetId: asset.id,
      name: "Accounting Test Campaign",
      incentiveBps: 100, // 1%
      fundingSource: "dramp",
      startDate: new Date(Date.now() - 86400000),
      endDate: new Date(Date.now() + 86400000),
      totalBudget: new Decimal(100),
      perTxnCap: null,
      volumeCap: null,
      qualifiedVolume: new Decimal(0),
      status: "ACTIVE",
      accrued: new Decimal(0),
      paid: new Decimal(0),
    },
  });

  // Simulate: accrue $30, then pay $30. remaining should be $70 (not $40).
  await db.settlementIncentiveCampaign.update({
    where: { id: campaign.id },
    data: { accrued: new Decimal(30), paid: new Decimal(30) },
  });

  // Import the function under test.
  const { getCampaignStats } = await import("../src/lib/provider-api/incentives");
  const stats = await getCampaignStats(campaign.id);
  assert(stats!.accrued === "30", "accrued = 30");
  assert(stats!.paid === "30", "paid = 30");
  assert(stats!.remaining === "70", "remaining = 70 (totalBudget - accrued, NOT - accrued - paid)");
  assert(stats!.unpaidAccrued === "0", "unpaidAccrued = 0 (accrued - paid)");

  // Now accrue another $20 (unpaid). remaining should be $50, unpaidAccrued = $20.
  await db.settlementIncentiveCampaign.update({
    where: { id: campaign.id },
    data: { accrued: new Decimal(50), paid: new Decimal(30) },
  });
  const stats2 = await getCampaignStats(campaign.id);
  assert(stats2!.remaining === "50", "remaining = 50 after accruing $20 more");
  assert(stats2!.unpaidAccrued === "20", "unpaidAccrued = 20");

  // =========================================================================
  // 2. CONCURRENT ACCRUAL — BUDGET CANNOT BE OVERSPENT
  // =========================================================================
  console.log("\n== 2. Concurrent accrual: budget cannot be overspent ==");

  // Pause the accounting campaign from test 1 so it doesn't interfere.
  await db.settlementIncentiveCampaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });

  // Create a campaign with a tight budget: $100, 100 bps (1%).
  // Create 10 fake "executions" each eligible for $20 incentive (2000 volume × 1%).
  // 10 × $20 = $200 > $100 budget → only $100 worth should accrue.
  const budgetCampaign = await db.settlementIncentiveCampaign.create({
    data: {
      settlementAssetId: asset.id,
      name: "Concurrent Budget Test",
      incentiveBps: 100, // 1%
      fundingSource: "dramp",
      startDate: new Date(Date.now() - 86400000),
      endDate: new Date(Date.now() + 86400000),
      totalBudget: new Decimal(100),
      perTxnCap: null,
      volumeCap: null,
      qualifiedVolume: new Decimal(0),
      status: "ACTIVE",
      accrued: new Decimal(0),
      paid: new Decimal(0),
    },
  });

  // Create a test provider + 10 test executions + legs.
  const provider = await db.liquidityProvider.create({
    data: {
      name: "Concurrent Test Provider",
      providerType: "BANK",
      trustModel: "COLLATERALIZED",
      capabilities: "[]",
      countries: "[]",
      reputationScore: 0.8,
      status: "ACTIVE",
    },
  });
  const offer = await db.liquidityOffer.create({
    data: {
      providerId: provider.id,
      capability: "FIAT_IN",
      sourceAsset: "USD",
      destinationAsset: "TEST_USDC",
      sourceCountry: "US",
      destinationCountry: "GLOBAL",
      rate: new Decimal(1),
      feeBps: 10,
      minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000),
      availableCapacity: new Decimal(1000000),
      reservedCapacity: new Decimal(0),
      settlementAssetId: asset.id,
      channelType: "AUTOMATIC",
      expectedExecutionSeconds: 10,
      incentiveBps: 0,
      active: true,
    },
  });

  const intent = await db.executionIntent.create({
    data: {
      userId: testUser.id,
      sourceAmount: new Decimal(2000),
      sourceAsset: "USD",
      sourceCountry: "US",
      destinationAsset: "TEST_USDC",
      destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED",
      executionPolicy: "NOW",
      maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]",
      prohibitedSettlementAssets: "[]",
      status: "COMPLETED",
      expiresAt: new Date(Date.now() + 60000),
    },
  });

  const executionIds: string[] = [];
  const routeIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const exec = await db.execution.create({
      data: {
        intentId: intent.id,
        attemptNumber: i + 1,
        status: "COMPLETED",
        commitmentStatus: "IRREVERSIBLE",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    const route = await db.route.create({
      data: {
        executionId: exec.id,
        legCount: 1,
        totalCost: new Decimal(0),
        effectiveCost: new Decimal(0),
        grossOutput: new Decimal(2000),
        netOutput: new Decimal(2000),
        incentiveBps: 0,
        riskCounterparty: 0.1,
        riskSettlementAsset: 0.1,
        riskLiquidity: 0.1,
        riskOperational: 0.1,
        riskDuration: 0.1,
        riskComposite: 0.1,
        expectedExecutionSeconds: 10,
        explanation: "test",
        tag: "BEST",
        status: "SELECTED",
        splitRoute: false,
      },
    });
    routeIds.push(route.id);
    await db.leg.create({
      data: {
        routeId: route.id,
        executionId: exec.id,
        providerId: provider.id,
        offerId: offer.id,
        sequence: 0,
        role: "SOURCE",
        amount: new Decimal(2000), // 2000 volume → 1% = 20 incentive
        sourceAsset: "USD",
        destinationAsset: "TEST_USDC",
        settlementAssetId: asset.id,
        channelType: "AUTOMATIC",
        status: "CONFIRMED",
        commitmentStatus: "IRREVERSIBLE",
      },
    });
    executionIds.push(exec.id);
  }

  // Now call accrueIncentiveForExecution for all 20 executions CONCURRENTLY.
  const { accrueIncentiveForExecution } = await import("../src/lib/provider-api/incentives");
  console.log(`  Firing ${executionIds.length} concurrent accruals against $100 budget...`);
  const results = await Promise.allSettled(executionIds.map((id) => accrueIncentiveForExecution(id)));
  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  assert(succeeded === 10, "All 10 concurrent accrual calls completed without error");

  // Check the campaign's accrued — must be <= totalBudget (100).
  const afterCampaign = await db.settlementIncentiveCampaign.findUnique({ where: { id: budgetCampaign.id } });
  const accrued = new Decimal(afterCampaign!.accrued);
  console.log(`  accrued = ${accrued.toString()} (budget = 100)`);
  assert(accrued.lte(100), `accrued (${accrued.toString()}) <= totalBudget (100) — no overspend`);
  assert(accrued.gt(0), "accrued > 0 — at least some incentives earned");

  // Count the number of earnings created.
  const earnings = await db.incentiveEarning.count({ where: { campaignId: budgetCampaign.id } });
  console.log(`  earnings created = ${earnings}`);
  assert(earnings <= 10, "earnings count <= 10 (unique constraint prevents duplicates)");
  // Sum of earnings should equal accrued.
  const earningsSum = await db.incentiveEarning.aggregate({
    where: { campaignId: budgetCampaign.id },
    _sum: { amount: true },
  });
  const totalEarned = new Decimal(earningsSum._sum.amount ?? 0);
  assert(totalEarned.equals(accrued), `sum of earnings (${totalEarned.toString()}) === accrued (${accrued.toString()})`);

  // =========================================================================
  // 3. CONCURRENT ACCRUAL — VOLUME CAP CANNOT BE EXCEEDED
  // =========================================================================
  console.log("\n== 3. Concurrent accrual: volume cap cannot be exceeded ==");

  const volCampaign = await db.settlementIncentiveCampaign.create({
    data: {
      settlementAssetId: asset.id,
      name: "Concurrent Volume Cap Test",
      incentiveBps: 10, // 0.1%
      fundingSource: "dramp",
      startDate: new Date(Date.now() - 86400000),
      endDate: new Date(Date.now() + 86400000),
      totalBudget: new Decimal(100000), // large budget so volume cap is the binding constraint
      perTxnCap: null,
      volumeCap: new Decimal(5000), // only 5000 volume qualifies
      qualifiedVolume: new Decimal(0),
      status: "ACTIVE",
      accrued: new Decimal(0),
      paid: new Decimal(0),
    },
  });

  // 10 executions × 1000 volume each = 10000 total > 5000 cap.
  const volExecutionIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const exec = await db.execution.create({
      data: {
        intentId: intent.id,
        attemptNumber: 100 + i,
        status: "COMPLETED",
        commitmentStatus: "IRREVERSIBLE",
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    const volRoute = await db.route.create({
      data: {
        executionId: exec.id,
        legCount: 1,
        totalCost: new Decimal(0),
        effectiveCost: new Decimal(0),
        grossOutput: new Decimal(1000),
        netOutput: new Decimal(1000),
        incentiveBps: 0,
        riskCounterparty: 0.1,
        riskSettlementAsset: 0.1,
        riskLiquidity: 0.1,
        riskOperational: 0.1,
        riskDuration: 0.1,
        riskComposite: 0.1,
        expectedExecutionSeconds: 10,
        explanation: "vol test",
        tag: "BEST",
        status: "SELECTED",
        splitRoute: false,
      },
    });
    routeIds.push(volRoute.id);
    await db.leg.create({
      data: {
        routeId: volRoute.id,
        executionId: exec.id,
        providerId: provider.id,
        offerId: offer.id,
        sequence: 0,
        role: "SOURCE",
        amount: new Decimal(1000),
        sourceAsset: "USD",
        destinationAsset: "TEST_USDC",
        settlementAssetId: asset.id,
        channelType: "AUTOMATIC",
        status: "CONFIRMED",
        commitmentStatus: "IRREVERSIBLE",
      },
    });
    volExecutionIds.push(exec.id);
  }

  // The legs use the same offer, which has settlementAssetId = asset.id.
  // But getApplicableIncentiveBps looks up campaigns by settlementAssetId.
  // We need the campaign to be found — it will be, since both campaigns are for the same asset.
  // To isolate the volume-cap campaign, pause the budget campaign.
  await db.settlementIncentiveCampaign.update({ where: { id: budgetCampaign.id }, data: { status: "PAUSED" } });

  console.log(`  Firing ${volExecutionIds.length} concurrent accruals against 5000 volume cap...`);
  await Promise.allSettled(volExecutionIds.map((id) => accrueIncentiveForExecution(id)));

  const afterVol = await db.settlementIncentiveCampaign.findUnique({ where: { id: volCampaign.id } });
  const qualifiedVolume = new Decimal(afterVol!.qualifiedVolume);
  console.log(`  qualifiedVolume = ${qualifiedVolume.toString()} (cap = 5000)`);
  assert(qualifiedVolume.lte(5000), `qualifiedVolume (${qualifiedVolume.toString()}) <= volumeCap (5000) — no over-volume`);
  assert(qualifiedVolume.gt(0), "qualifiedVolume > 0 — at least some volume qualified");

  // =========================================================================
  // 4. PARTIAL SLASH — UN-SLASHED PORTION RELEASED BACK TO AVAILABLE
  // =========================================================================
  console.log("\n== 4. Partial slash: un-slashed portion released back ==");

  // Create a collateralized provider with a vault.
  const slashProvider = await db.liquidityProvider.create({
    data: {
      name: "Slash Test Provider",
      providerType: "BANK",
      trustModel: "COLLATERALIZED",
      capabilities: "[]",
      countries: "[]",
      reputationScore: 0.8,
      status: "ACTIVE",
    },
  });
  const vault = await db.vault.create({
    data: {
      providerId: slashProvider.id,
      holdingsJson: JSON.stringify([{ asset: "TEST_USDC", amount: "10000" }]),
      usableCollateral: new Decimal(10000),
      lockedCollateral: new Decimal(0),
      collateralizationRatio: 1.5,
      maxExposure: new Decimal(6666.67),
    },
  });
  await db.liquidityProvider.update({ where: { id: slashProvider.id }, data: { vaultId: vault.id } });

  // Create an execution + lock $1000 collateral.
  const slashIntent = await db.executionIntent.create({
    data: {
      userId: testUser.id,
      sourceAmount: new Decimal(1000),
      sourceAsset: "USD",
      sourceCountry: "US",
      destinationAsset: "TEST_USDC",
      destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED",
      executionPolicy: "NOW",
      maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]",
      prohibitedSettlementAssets: "[]",
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const slashExec = await db.execution.create({
    data: {
      intentId: slashIntent.id,
      attemptNumber: 1,
      status: "ROUTE_RESERVED",
      commitmentStatus: "REVERSIBLE",
      startedAt: new Date(),
    },
  });
  await db.collateralLock.create({
    data: {
      vaultId: vault.id,
      providerId: slashProvider.id,
      executionId: slashExec.id,
      amount: new Decimal(1000),
      asset: "TEST_USDC",
      status: "LOCKED",
    },
  });
  await db.vault.update({
    where: { id: vault.id },
    data: { lockedCollateral: new Decimal(1000) },
  });

  // Record pre-slash state.
  const preVault = await db.vault.findUnique({ where: { id: vault.id } });
  const preUsable = new Decimal(preVault!.usableCollateral);
  const preLocked = new Decimal(preVault!.lockedCollateral);
  console.log(`  pre-slash: usable=${preUsable.toString()}, locked=${preLocked.toString()}`);

  // Slash $100 (10% of locked).
  const { slashCollateralAmount } = await import("../src/lib/engine/collateral");
  const slashResult = await db.$transaction(async (tx) => {
    return slashCollateralAmount(slashExec.id, new Decimal(100), "TEST_USDC", "dispute:comp", tx);
  }, { timeout: 30000, maxWait: 15000 });

  assert(slashResult.slashedAmount.equals(100), "Slashed amount = 100 (exact)");
  assert(slashResult.totalEligibleLocked.equals(1000), "totalEligibleLocked = 1000");

  // Check post-slash vault state.
  const postVault = await db.vault.findUnique({ where: { id: vault.id } });
  const postUsable = new Decimal(postVault!.usableCollateral);
  const postLocked = new Decimal(postVault!.lockedCollateral);
  console.log(`  post-slash: usable=${postUsable.toString()}, locked=${postLocked.toString()}`);

  // usable should decrease by EXACTLY $100 (the slash amount).
  assert(preUsable.minus(postUsable).equals(100), `usableCollateral decreased by exactly 100 (got ${preUsable.minus(postUsable).toString()})`);
  // locked should be 0 (all locks released; the un-slashed $900 goes back to available).
  assert(postLocked.equals(0), `lockedCollateral = 0 after slash (all locks released, got ${postLocked.toString()})`);
  // The un-slashed portion ($900) is now available again (usable decreased by $100, locked decreased by $1000;
  // the $900 difference is released back to the provider's available headroom).
  const releasedBack = preLocked.minus(postLocked).minus(slashResult.slashedAmount);
  assert(releasedBack.equals(900), `un-slashed portion (900) released back (got ${releasedBack.toString()})`);

  // Verify a SLASH ledger entry was created for the exact amount.
  const slashEntry = await db.ledgerEntry.findFirst({
    where: { executionId: slashExec.id, entryType: "SLASH" },
  });
  assert(!!slashEntry, "SLASH ledger entry created");
  assert(new Decimal(slashEntry!.amount).equals(100), `ledger entry amount = 100 (got ${slashEntry!.amount.toString()})`);

  // Verify the collateral lock is marked SLASHED.
  const locks = await db.collateralLock.findMany({ where: { executionId: slashExec.id } });
  assert(locks.every((l) => l.status === "SLASHED"), "All collateral locks marked SLASHED");

  // =========================================================================
  // CLEANUP (order matters for FK constraints)
  // =========================================================================
  console.log("\n== Cleanup ==");
  // Delete all test executions + intents that reference the test user/provider.
  const testIntentIds = await db.executionIntent.findMany({ where: { userId: testUser.id }, select: { id: true } });
  const testIntentIdList = testIntentIds.map((i) => i.id);
  if (testIntentIdList.length > 0) {
    const testExecs = await db.execution.findMany({ where: { intentId: { in: testIntentIdList } }, select: { id: true } });
    const testExecIdList = testExecs.map((e) => e.id);
    if (testExecIdList.length > 0) {
      await db.ledgerEntry.deleteMany({ where: { executionId: { in: testExecIdList } } });
      await db.collateralLock.deleteMany({ where: { executionId: { in: testExecIdList } } });
      await db.leg.deleteMany({ where: { executionId: { in: testExecIdList } } });
      await db.route.deleteMany({ where: { executionId: { in: testExecIdList } } });
      await db.execution.deleteMany({ where: { id: { in: testExecIdList } } });
    }
    await db.executionIntent.deleteMany({ where: { id: { in: testIntentIdList } } });
  }
  await db.incentiveEarning.deleteMany({ where: { campaignId: { in: [campaign.id, budgetCampaign.id, volCampaign.id] } } });
  await db.settlementIncentiveCampaign.deleteMany({ where: { id: { in: [campaign.id, budgetCampaign.id, volCampaign.id] } } });
  await db.liquidityOffer.deleteMany({ where: { providerId: { in: [provider.id, slashProvider.id] } } });
  await db.vault.deleteMany({ where: { providerId: slashProvider.id } });
  await db.liquidityProvider.deleteMany({ where: { id: { in: [provider.id, slashProvider.id] } } });
  await db.settlementAsset.deleteMany({ where: { symbol: "TEST_USDC" } });
  await db.user.deleteMany({ where: { email: "test-accounting@dramp.test" } });
  console.log("  Done");

  console.log(`\n========================================`);
  console.log(`  P2.2 Accounting: Passed: ${passed}  |  Failed: ${failed}`);
  console.log(`========================================`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  
  process.exit(1);
});

export {};
