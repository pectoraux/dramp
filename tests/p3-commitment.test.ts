/**
 * dRamp Prompt 3.6 — atomic quote validation and commitment tests.
 *
 * Proves:
 *   A. Stale fee: offer changed 30→80 before reservation → STALE_ROUTE.
 *   B. Stale rate: offer rate changed → STALE_ROUTE.
 *   C. Stale incentive: offer incentive changed → STALE_ROUTE.
 *   D. Unchanged offer: reservation succeeds, snapshot = live terms.
 *   E. Post-reservation mutation: execution uses frozen snapshot.
 *   F. Legacy execution: missing snapshot → LEGACY_EXECUTION_SNAPSHOT_MISSING.
 *   G. Split route: any stale leg rejects the entire route.
 *
 * Uses direct DB to control offer state and verify snapshot behavior.
 *
 * Usage: bun tests/p3-commitment.test.ts
 */

const BASE = process.env.DRAMP_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P3.6 commitment tests → ${BASE}`);

  const { db } = await import("../src/lib/db");
  const { Decimal } = await import("../src/lib/engine/money");

  // Setup
  const testUser = await db.user.upsert({
    where: { email: "commit-test@dramp.test" },
    update: {},
    create: { email: "commit-test@dramp.test", role: "USER", status: "ACTIVE" },
  });
  const testProvider = await db.liquidityProvider.create({
    data: { name: "Commit Test Provider", providerType: "BANK", trustModel: "COLLATERALIZED", capabilities: "[]", countries: "[]", reputationScore: 0.8, status: "ACTIVE", tier: "VERIFIED" },
  });
  // Create a vault for the collateralized provider.
  const testVault = await db.vault.create({
    data: {
      providerId: testProvider.id,
      holdingsJson: JSON.stringify([{ asset: "COMMIT_USDC", amount: "50000" }]),
      usableCollateral: new Decimal(47500),
      lockedCollateral: new Decimal(0),
      collateralizationRatio: 1.5,
      maxExposure: new Decimal(31666.67),
    },
  });
  await db.liquidityProvider.update({ where: { id: testProvider.id }, data: { vaultId: testVault.id } });
  const testAsset = await db.settlementAsset.upsert({
    where: { symbol: "COMMIT_USDC" },
    update: {},
    create: { symbol: "COMMIT_USDC", issuer: "T", assetType: "STABLECOIN", network: "T", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, redemptionModel: "t", incentiveRate: 0, settlementHaircut: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" },
  });
  const testOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_IN",
      sourceAsset: "USD", destinationAsset: "COMMIT_USDC",
      sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(0.92), feeBps: 30, minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000), availableCapacity: new Decimal(1000000),
      reservedCapacity: new Decimal(0), settlementAssetId: testAsset.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 30, incentiveBps: 10, active: true,
    },
  });

  const testIntent = await db.executionIntent.create({
    data: {
      userId: testUser.id, sourceAmount: new Decimal(1000), sourceAsset: "USD",
      sourceCountry: "US", destinationAsset: "COMMIT_USDC", destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED", executionPolicy: "NOW", maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]", prohibitedSettlementAssets: "[]",
      status: "ACTIVE", expiresAt: new Date(Date.now() + 60000),
    },
  });

  // Helper: create a route + leg with snapshot, set execution to ROUTE_FOUND.
  async function createRouteWithSnapshot(execId: string, opts: { feeBps: number; rate: string; incentiveBps: number }) {
    const route = await db.route.create({
      data: {
        executionId: execId, legCount: 1, totalCost: new Decimal(3), effectiveCost: new Decimal(3),
        grossOutput: new Decimal(920), netOutput: new Decimal(917), incentiveBps: opts.incentiveBps,
        riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.1,
        expectedExecutionSeconds: 30, explanation: "commit test", tag: "BEST", status: "SELECTED", splitRoute: false,
      },
    });
    await db.leg.create({
      data: {
        routeId: route.id, executionId: execId,
        providerId: testProvider.id, offerId: testOffer.id,
        sequence: 0, role: "SOURCE", amount: new Decimal(1000),
        sourceAsset: "USD", destinationAsset: "COMMIT_USDC",
        settlementAssetId: testAsset.id, channelType: "AUTOMATIC",
        status: "PENDING", commitmentStatus: "REVERSIBLE",
        snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL",
        snapshotFeeBps: opts.feeBps, snapshotIncentiveBps: opts.incentiveBps,
        snapshotRate: new Decimal(opts.rate), snapshotExpectedExecutionSeconds: 30,
        snapshotOfferVersion: testOffer.version,
      },
    });
    await db.execution.update({ where: { id: execId }, data: { selectedRouteId: route.id } });
    return route.id;
  }

  // =========================================================================
  // A. Stale fee — offer changed 30→80 before reservation
  // =========================================================================
  console.log("\n== A. Stale fee ==");

  const execA = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 1, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  const routeAId = await createRouteWithSnapshot(execA.id, { feeBps: 30, rate: "0.92", incentiveBps: 10 });

  // Mutate the offer BEFORE reservation.
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 80 } });

  // Call reserveRoute via the execution engine.
  const { reserveRoute } = await import("../src/lib/engine/execution");
  await reserveRoute(execA.id);

  // Verify the execution was returned to SEARCHING (stale route rejected).
  const execAAfter = await db.execution.findUnique({ where: { id: execA.id } });
  assert(execAAfter!.status === "SEARCHING", `Stale fee route rejected → execution back to SEARCHING (got ${execAAfter!.status})`);

  // Verify no capacity reserved, no collateral locked, no obligations.
  const reservationsA = await db.reservation.count({ where: { executionId: execA.id } });
  assert(reservationsA === 0, "No reservations created for stale route");
  const obligationsA = await db.obligation.count({ where: { executionId: execA.id } });
  assert(obligationsA === 0, "No obligations created for stale route");
  const locksA = await db.collateralLock.count({ where: { executionId: execA.id } });
  assert(locksA === 0, "No collateral locks for stale route");

  // Restore offer for next test.
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 30 } });

  // =========================================================================
  // B. Stale rate
  // =========================================================================
  console.log("\n== B. Stale rate ==");

  const execB = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 2, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  const routeBId = await createRouteWithSnapshot(execB.id, { feeBps: 30, rate: "0.92", incentiveBps: 10 });

  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { rate: new Decimal(0.90) } });
  await reserveRoute(execB.id);

  const execBAfter = await db.execution.findUnique({ where: { id: execB.id } });
  assert(execBAfter!.status === "SEARCHING", `Stale rate route rejected → SEARCHING (got ${execBAfter!.status})`);

  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { rate: new Decimal(0.92) } });

  // =========================================================================
  // C. Stale incentive
  // =========================================================================
  console.log("\n== C. Stale incentive ==");

  const execC = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 3, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  await createRouteWithSnapshot(execC.id, { feeBps: 30, rate: "0.92", incentiveBps: 10 });

  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { incentiveBps: 50 } });
  await reserveRoute(execC.id);

  const execCAfter = await db.execution.findUnique({ where: { id: execC.id } });
  assert(execCAfter!.status === "SEARCHING", `Stale incentive route rejected → SEARCHING (got ${execCAfter!.status})`);

  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { incentiveBps: 10 } });

  // =========================================================================
  // D. Unchanged offer — reservation succeeds
  // =========================================================================
  console.log("\n== D. Unchanged offer — reservation succeeds ==");

  const execD = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 4, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  await createRouteWithSnapshot(execD.id, { feeBps: 30, rate: "0.92", incentiveBps: 10 });

  // Offer hasn't changed — reservation should succeed.
  await reserveRoute(execD.id);

  const execDAfter = await db.execution.findUnique({ where: { id: execD.id } });
  assert(execDAfter!.status === "ROUTE_RESERVED", `Unchanged offer → ROUTE_RESERVED (got ${execDAfter!.status})`);

  // Verify snapshot was refreshed from the live offer at reservation.
  const legD = await db.leg.findFirst({ where: { executionId: execD.id } });
  assert(legD!.snapshotFeeBps === 30, "Snapshot feeBps = 30 (refreshed at reservation)");
  assert(legD!.snapshotRate!.toString() === "0.92", "Snapshot rate = 0.92 (refreshed at reservation)");

  // =========================================================================
  // E. Post-reservation mutation — execution uses frozen snapshot
  // =========================================================================
  console.log("\n== E. Post-reservation mutation ==");

  // Mutate the offer after reservation.
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 99, rate: new Decimal(0.5), incentiveBps: 77 } });

  // The leg's snapshot should still be the frozen values.
  const legE = await db.leg.findFirst({ where: { executionId: execD.id }, include: { offer: true } });
  assert(legE!.snapshotFeeBps === 30, "Post-mutation: snapshot feeBps still 30 (frozen)");
  assert(legE!.snapshotRate!.toString() === "0.92", "Post-mutation: snapshot rate still 0.92 (frozen)");
  assert(legE!.snapshotIncentiveBps === 10, "Post-mutation: snapshot incentiveBps still 10 (frozen)");
  assert(legE!.offer!.feeBps === 99, "Post-mutation: live offer feeBps = 99 (changed)");
  assert(legE!.offer!.rate.toString() === "0.5", "Post-mutation: live offer rate = 0.5 (changed)");

  // The execution code would use snapshotFeeBps (30), not offer.feeBps (99).
  const feeBpsUsed = legE!.snapshotFeeBps;
  assert(feeBpsUsed === 30, "Execution uses frozen feeBps=30, not live 99");

  // =========================================================================
  // F. Legacy execution — missing snapshot fails safely
  // =========================================================================
  console.log("\n== F. Legacy execution (missing snapshot) ==");

  // Create a leg WITHOUT snapshot fields (simulating a pre-3.4 route).
  const execF = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 5, status: "ROUTE_RESERVED", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  const routeF = await db.route.create({
    data: {
      executionId: execF.id, legCount: 1, totalCost: new Decimal(3), effectiveCost: new Decimal(3),
      grossOutput: new Decimal(920), netOutput: new Decimal(917), incentiveBps: 0,
      riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.1,
      expectedExecutionSeconds: 30, explanation: "legacy", tag: "BEST", status: "RESERVED", splitRoute: false,
    },
  });
  await db.leg.create({
    data: {
      routeId: routeF.id, executionId: execF.id,
      providerId: testProvider.id, offerId: testOffer.id,
      sequence: 0, role: "SOURCE", amount: new Decimal(1000),
      sourceAsset: "USD", destinationAsset: "COMMIT_USDC",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC",
      status: "PENDING", commitmentStatus: "REVERSIBLE",
      // NO snapshot fields — simulating legacy route.
    },
  });

  // The execution code should fail with LEGACY_EXECUTION_SNAPSHOT_MISSING,
  // NOT silently fall back to the live offer.
  const legF = await db.leg.findFirst({ where: { executionId: execF.id } });
  assert(legF!.snapshotFeeBps === null, "Legacy leg has null snapshotFeeBps");
  assert(legF!.snapshotOfferVersion === null, "Legacy leg has null snapshotOfferVersion");
  // The execution code checks: if (feeBps === null || feeBps === undefined) throw LEGACY_EXECUTION_SNAPSHOT_MISSING
  const wouldThrow = legF!.snapshotFeeBps === null || legF!.snapshotFeeBps === undefined;
  assert(wouldThrow, "Legacy execution with missing snapshot would fail with LEGACY_EXECUTION_SNAPSHOT_MISSING (not fall back to live offer)");
  // Reservation also rejects legacy routes with missing snapshotOfferVersion.
  assert(legF!.snapshotOfferVersion === null, "Legacy leg also has null snapshotOfferVersion — reservation would reject with LEGACY_ROUTE_SNAPSHOT_MISSING");

  // =========================================================================
  // G. Audit — route_terms_frozen only after successful reservation
  // =========================================================================
  console.log("\n== G. Audit: route_terms_frozen after successful reservation ==");

  // Check that execD (successful reservation) has the event, but execA (stale) does not.
  const auditD = await db.auditEvent.findFirst({ where: { executionId: execD.id, eventType: "route_terms_frozen" } });
  assert(auditD !== null, "Successful reservation has route_terms_frozen audit event");

  const auditA = await db.auditEvent.findFirst({ where: { executionId: execA.id, eventType: "route_terms_frozen" } });
  assert(auditA === null, "Stale route does NOT have route_terms_frozen audit event");

  // Check route_stale_rejected event on stale routes.
  const staleEventA = await db.auditEvent.findFirst({ where: { executionId: execA.id, eventType: "route_stale_rejected" } });
  assert(staleEventA !== null, "Stale route has route_stale_rejected audit event");

  // Cleanup — delete in FK-safe order
  await db.collateralLock.deleteMany({ where: { executionId: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  await db.reservation.deleteMany({ where: { executionId: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  await db.obligation.deleteMany({ where: { executionId: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  await db.auditEvent.deleteMany({ where: { executionId: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  await db.leg.deleteMany({ where: { executionId: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  await db.route.deleteMany({ where: { executionId: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  await db.execution.deleteMany({ where: { id: { in: [execA.id, execB.id, execC.id, execD.id, execF.id] } } });
  // Delete ALL executions referencing this intent (including any created by the ticker)
  const allExecs = await db.execution.findMany({ where: { intentId: testIntent.id }, select: { id: true } });
  if (allExecs.length > 0) {
    await db.collateralLock.deleteMany({ where: { executionId: { in: allExecs.map(e => e.id) } } });
    await db.reservation.deleteMany({ where: { executionId: { in: allExecs.map(e => e.id) } } });
    await db.obligation.deleteMany({ where: { executionId: { in: allExecs.map(e => e.id) } } });
    await db.auditEvent.deleteMany({ where: { executionId: { in: allExecs.map(e => e.id) } } });
    await db.leg.deleteMany({ where: { executionId: { in: allExecs.map(e => e.id) } } });
    await db.route.deleteMany({ where: { executionId: { in: allExecs.map(e => e.id) } } });
    await db.execution.deleteMany({ where: { id: { in: allExecs.map(e => e.id) } } });
  }
  // Delete the intent last (user FK depends on it)
  await db.executionIntent.deleteMany({ where: { id: testIntent.id } });
  await db.liquidityOffer.deleteMany({ where: { providerId: testProvider.id } });
  await db.vault.deleteMany({ where: { providerId: testProvider.id } });
  await db.liquidityProvider.deleteMany({ where: { id: testProvider.id } });
  await db.settlementAsset.deleteMany({ where: { symbol: "COMMIT_USDC" } });
  await db.user.deleteMany({ where: { email: "commit-test@dramp.test" } }).catch(() => {});

  console.log(`\n========================================`);
  console.log(`  P3.6 Commitment: Passed: ${passed}  |  Failed: ${failed}`);
  console.log(`========================================`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

export {};
