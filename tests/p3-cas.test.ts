/**
 * dRamp Prompt 3.8 — atomic offer version compare-and-swap tests.
 *
 * Proves:
 *   A. No concurrent mutation → reservation succeeds.
 *   B. Offer mutated before reservation → STALE_ROUTE (version mismatch).
 *   C. Two concurrent reservations → only one succeeds.
 *   D. Multi-leg route with one stale leg → entire route rolls back.
 *   E. Post-reservation offer mutation → committed execution unchanged.
 *   F. Legacy route missing version → explicit legacy failure.
 *   G. CAS increments offer version (concurrency lock).
 *
 * Usage: bun tests/p3-cas.test.ts
 */

const BASE = process.env.DRAMP_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P3.8 CAS tests → ${BASE}`);

  const { db } = await import("../src/lib/db");
  const { Decimal } = await import("../src/lib/engine/money");

  // Setup
  const testUser = await db.user.upsert({
    where: { email: "cas-test@dramp.test" },
    update: {},
    create: { email: "cas-test@dramp.test", role: "USER", status: "ACTIVE" },
  });
  const testProvider = await db.liquidityProvider.create({
    data: { name: "CAS Test Provider", providerType: "BANK", trustModel: "COLLATERALIZED", capabilities: "[]", countries: "[]", reputationScore: 0.8, status: "ACTIVE", tier: "VERIFIED" },
  });
  const testVault = await db.vault.create({
    data: { providerId: testProvider.id, holdingsJson: JSON.stringify([{ asset: "CAS_USDC", amount: "50000" }]), usableCollateral: new Decimal(47500), lockedCollateral: new Decimal(0), collateralizationRatio: 1.5, maxExposure: new Decimal(31666.67) },
  });
  await db.liquidityProvider.update({ where: { id: testProvider.id }, data: { vaultId: testVault.id } });
  const testAsset = await db.settlementAsset.upsert({
    where: { symbol: "CAS_USDC" },
    update: {},
    create: { symbol: "CAS_USDC", issuer: "T", assetType: "STABLECOIN", network: "T", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, redemptionModel: "t", incentiveRate: 0, settlementHaircut: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" },
  });

  // Create an offer with limited capacity for concurrency testing.
  const testOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_IN",
      sourceAsset: "USD", destinationAsset: "CAS_USDC",
      sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(0.92), feeBps: 30, minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000), availableCapacity: new Decimal(5000),
      reservedCapacity: new Decimal(0), settlementAssetId: testAsset.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 30, incentiveBps: 10, active: true,
    },
  });

  const testIntent = await db.executionIntent.create({
    data: {
      userId: testUser.id, sourceAmount: new Decimal(1000), sourceAsset: "USD",
      sourceCountry: "US", destinationAsset: "CAS_USDC", destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED", executionPolicy: "NOW", maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]", prohibitedSettlementAssets: "[]",
      status: "ACTIVE", expiresAt: new Date(Date.now() + 60000),
    },
  });

  async function createRouteWithSnapshot(execId: string, offerVersion: number | null, amount: number = 1000) {
    const route = await db.route.create({
      data: {
        executionId: execId, legCount: 1, totalCost: new Decimal(3), effectiveCost: new Decimal(3),
        grossOutput: new Decimal(920), netOutput: new Decimal(917), incentiveBps: 10,
        riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.1,
        expectedExecutionSeconds: 30, explanation: "cas test", tag: "BEST", status: "SELECTED", splitRoute: false,
      },
    });
    await db.leg.create({
      data: {
        routeId: route.id, executionId: execId,
        providerId: testProvider.id, offerId: testOffer.id,
        sequence: 0, role: "SOURCE", amount: new Decimal(amount),
        sourceAsset: "USD", destinationAsset: "CAS_USDC",
        settlementAssetId: testAsset.id, channelType: "AUTOMATIC",
        status: "PENDING", commitmentStatus: "REVERSIBLE",
        snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL",
        snapshotFeeBps: 30, snapshotIncentiveBps: 10,
        snapshotRate: new Decimal(0.92), snapshotExpectedExecutionSeconds: 30,
        snapshotOfferVersion: offerVersion,
      },
    });
    await db.execution.update({ where: { id: execId }, data: { selectedRouteId: route.id } });
    return route.id;
  }

  const { reserveRoute } = await import("../src/lib/engine/execution");

  // =========================================================================
  // A. No concurrent mutation → reservation succeeds
  // =========================================================================
  console.log("\n== A. No concurrent mutation ==");

  const offerVersionA = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;
  const execA = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 1, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  await createRouteWithSnapshot(execA.id, offerVersionA);
  await reserveRoute(execA.id);
  const execAAfter = await db.execution.findUnique({ where: { id: execA.id } });
  assert(execAAfter!.status === "ROUTE_RESERVED", `No mutation → ROUTE_RESERVED (got ${execAAfter!.status})`);

  // =========================================================================
  // G. CAS increments offer version (concurrency lock)
  // =========================================================================
  console.log("\n== G. CAS increments offer version ==");

  const offerVersionAfterA = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;
  assert(offerVersionAfterA === offerVersionA + 1, `CAS incremented offer version from ${offerVersionA} to ${offerVersionAfterA}`);

  // The leg's snapshotOfferVersion should still be the OBSERVED version (not incremented).
  const legA = await db.leg.findFirst({ where: { executionId: execA.id } });
  assert(legA!.snapshotOfferVersion === offerVersionA, `Leg snapshotOfferVersion = ${offerVersionA} (observed), not ${offerVersionAfterA} (incremented)`);

  // =========================================================================
  // B. Offer mutated before reservation → STALE_ROUTE
  // =========================================================================
  console.log("\n== B. Offer mutated before reservation ==");

  const currentVersion = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;
  const execB = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 2, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  // Snapshot the current version, then mutate the offer.
  await createRouteWithSnapshot(execB.id, currentVersion);
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 50, version: { increment: 1 } } });

  await reserveRoute(execB.id);
  const execBAfter = await db.execution.findUnique({ where: { id: execB.id } });
  assert(execBAfter!.status === "SEARCHING", `Mutated offer → STALE_ROUTE (got ${execBAfter!.status})`);

  // No side effects.
  const resB = await db.reservation.count({ where: { executionId: execB.id } });
  assert(resB === 0, "No reservations for stale route");
  const oblB = await db.obligation.count({ where: { executionId: execB.id } });
  assert(oblB === 0, "No obligations for stale route");

  // =========================================================================
  // C. Two concurrent reservations → only one succeeds (capacity race)
  // =========================================================================
  console.log("\n== C. Two concurrent reservations (capacity race) ==");

  // Reset the offer capacity and version for this test.
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { availableCapacity: new Decimal(1500), reservedCapacity: new Decimal(0), feeBps: 30 } });
  const raceVersion = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;

  // Two executions, each trying to reserve $1000 from an offer with $1500 capacity.
  // Both should pass the version check (same version), but only one should win
  // the capacity reservation (conditional update on reservedCapacity).
  const execC1 = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 3, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  const execC2 = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 4, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  await createRouteWithSnapshot(execC1.id, raceVersion, 1000);
  await createRouteWithSnapshot(execC2.id, raceVersion, 1000);

  // Run both reservations concurrently.
  const [result1, result2] = await Promise.allSettled([
    reserveRoute(execC1.id),
    reserveRoute(execC2.id),
  ]);

  // At least one should succeed (ROUTE_RESERVED), and the other should fail
  // (either STALE_ROUTE from CAS failure, or capacity exceeded).
  const execC1After = await db.execution.findUnique({ where: { id: execC1.id } });
  const execC2After = await db.execution.findUnique({ where: { id: execC2.id } });

  const c1Reserved = execC1After!.status === "ROUTE_RESERVED";
  const c2Reserved = execC2After!.status === "ROUTE_RESERVED";

  // At least one must succeed.
  assert(c1Reserved || c2Reserved, "At least one concurrent reservation succeeded");
  // They cannot both reserve $1000 from $1500 capacity (that would be $2000 > $1500).
  // Actually $1000 + $1000 = $2000 > $1500, so the second should fail on capacity.
  // But wait — the CAS increments the version, so the second CAS will fail too.
  // Let's check: if both have the same snapshotOfferVersion, the first CAS
  // increments the version, so the second CAS fails (version mismatch).
  // This means exactly one should succeed.
  assert(!(c1Reserved && c2Reserved), "Both concurrent reservations cannot succeed (CAS prevents double-commit)");

  // The one that failed should be back in SEARCHING.
  if (c1Reserved) {
    assert(execC2After!.status === "SEARCHING", `C2 failed → SEARCHING (got ${execC2After!.status})`);
  } else {
    assert(execC1After!.status === "SEARCHING", `C1 failed → SEARCHING (got ${execC1After!.status})`);
  }

  // =========================================================================
  // D. Multi-leg route with one stale leg → entire route rolls back
  // =========================================================================
  console.log("\n== D. Multi-leg route with one stale leg ==");

  // Create a second offer for the destination leg.
  const destOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_OUT",
      sourceAsset: "CAS_USDC", destinationAsset: "EUR",
      sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(1.0), feeBps: 20, minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000), availableCapacity: new Decimal(1000000),
      reservedCapacity: new Decimal(0), settlementAssetId: testAsset.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 20, incentiveBps: 0, active: true,
    },
  });

  const srcVersion = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;
  const destVersion = destOffer.version;

  const execD = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 5, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  const routeD = await db.route.create({
    data: {
      executionId: execD.id, legCount: 2, totalCost: new Decimal(5), effectiveCost: new Decimal(5),
      grossOutput: new Decimal(920), netOutput: new Decimal(915), incentiveBps: 0,
      riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.12,
      expectedExecutionSeconds: 50, explanation: "multi-leg cas", tag: "BEST", status: "SELECTED", splitRoute: false,
    },
  });
  // Leg 1: source, correct version.
  await db.leg.create({
    data: {
      routeId: routeD.id, executionId: execD.id, providerId: testProvider.id, offerId: testOffer.id,
      sequence: 0, role: "SOURCE", amount: new Decimal(1000), sourceAsset: "USD", destinationAsset: "CAS_USDC",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC", status: "PENDING", commitmentStatus: "REVERSIBLE",
      snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL", snapshotFeeBps: 30, snapshotIncentiveBps: 10,
      snapshotRate: new Decimal(0.92), snapshotExpectedExecutionSeconds: 30, snapshotOfferVersion: srcVersion,
    },
  });
  // Leg 2: destination, stale version (we'll increment it before reservation).
  await db.leg.create({
    data: {
      routeId: routeD.id, executionId: execD.id, providerId: testProvider.id, offerId: destOffer.id,
      sequence: 1, role: "DESTINATION", amount: new Decimal(917), sourceAsset: "CAS_USDC", destinationAsset: "EUR",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC", status: "PENDING", commitmentStatus: "REVERSIBLE",
      snapshotSourceCountry: "GLOBAL", snapshotDestinationCountry: "EU", snapshotFeeBps: 20, snapshotIncentiveBps: 0,
      snapshotRate: new Decimal(1.0), snapshotExpectedExecutionSeconds: 20, snapshotOfferVersion: destVersion,
    },
  });
  await db.execution.update({ where: { id: execD.id }, data: { selectedRouteId: routeD.id } });

  // Mutate the destination offer (increment version).
  await db.liquidityOffer.update({ where: { id: destOffer.id }, data: { feeBps: 50, version: { increment: 1 } } });

  // Attempt reservation — should fail because leg 2's version is stale.
  await reserveRoute(execD.id);
  const execDAfter = await db.execution.findUnique({ where: { id: execD.id } });
  assert(execDAfter!.status === "SEARCHING", `Multi-leg with stale leg → rejected (got ${execDAfter!.status})`);

  // No partial reservations.
  const resD = await db.reservation.count({ where: { executionId: execD.id } });
  assert(resD === 0, "No partial reservations for stale multi-leg route");
  const oblD = await db.obligation.count({ where: { executionId: execD.id } });
  assert(oblD === 0, "No partial obligations for stale multi-leg route");

  // =========================================================================
  // E. Post-reservation offer mutation → committed execution unchanged
  // =========================================================================
  console.log("\n== E. Post-reservation mutation ==");

  // execA was successfully reserved. Mutate the offer.
  const versionBefore = legA!.snapshotOfferVersion!;
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 99, version: { increment: 1 } } });

  // The leg's snapshot should still have the frozen version and terms.
  const legAAfter = await db.leg.findFirst({ where: { executionId: execA.id } });
  assert(legAAfter!.snapshotOfferVersion === versionBefore, `Post-mutation: snapshot version = ${versionBefore} (frozen)`);
  assert(legAAfter!.snapshotFeeBps === 30, "Post-mutation: snapshot feeBps = 30 (frozen), not 99");

  // =========================================================================
  // F. Legacy route missing version → explicit failure
  // =========================================================================
  console.log("\n== F. Legacy route missing version ==");

  const execF = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 6, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
  });
  await createRouteWithSnapshot(execF.id, null);
  await reserveRoute(execF.id);
  const execFAfter = await db.execution.findUnique({ where: { id: execF.id } });
  assert(execFAfter!.status === "SEARCHING", `Legacy missing version → rejected (got ${execFAfter!.status})`);

  const staleEvent = await db.auditEvent.findFirst({ where: { executionId: execF.id, eventType: "route_stale_rejected" } });
  assert(staleEvent !== null, "Legacy route has route_stale_rejected audit event");
  const payload = JSON.parse(staleEvent!.payloadJson);
  assert(payload.reason.includes("LEGACY_ROUTE_SNAPSHOT_MISSING"), "Rejection reason mentions LEGACY_ROUTE_SNAPSHOT_MISSING");

  // Cleanup
  const allExecIds = [execA.id, execB.id, execC1.id, execC2.id, execD.id, execF.id];
  await db.collateralLock.deleteMany({ where: { executionId: { in: allExecIds } } });
  await db.reservation.deleteMany({ where: { executionId: { in: allExecIds } } });
  await db.obligation.deleteMany({ where: { executionId: { in: allExecIds } } });
  await db.auditEvent.deleteMany({ where: { executionId: { in: allExecIds } } });
  await db.leg.deleteMany({ where: { executionId: { in: allExecIds } } });
  await db.route.deleteMany({ where: { executionId: { in: allExecIds } } });
  await db.execution.deleteMany({ where: { id: { in: allExecIds } } });
  await db.execution.deleteMany({ where: { intentId: testIntent.id } });
  await db.executionIntent.deleteMany({ where: { id: testIntent.id } });
  await db.liquidityOffer.deleteMany({ where: { providerId: testProvider.id } });
  await db.vault.deleteMany({ where: { providerId: testProvider.id } });
  await db.liquidityProvider.deleteMany({ where: { id: testProvider.id } });
  await db.settlementAsset.deleteMany({ where: { symbol: "CAS_USDC" } });
  await db.user.deleteMany({ where: { email: "cas-test@dramp.test" } }).catch(() => {});

  console.log(`\n========================================`);
  console.log(`  P3.8 CAS: Passed: ${passed}  |  Failed: ${failed}`);
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
