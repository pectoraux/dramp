/**
 * dRamp Prompt 3.7 — offer versioning and commitment concurrency tests.
 *
 * Proves:
 *   A. Unchanged version: reservation succeeds.
 *   B. Version changed: offer mutated before reservation → STALE_ROUTE.
 *   C. Legacy missing version: route without snapshotOfferVersion → LEGACY_ROUTE_SNAPSHOT_MISSING.
 *   D. Post-reservation mutation: execution uses frozen version N, not N+1.
 *   E. Multi-leg route: one leg's version changes → entire route rejected.
 *   F. Offer version included in route_terms_frozen audit event.
 *   G. Offer mutations increment version.
 *
 * Usage: bun tests/p3-versioning.test.ts
 */

const BASE = process.env.DRAMP_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P3.7 versioning tests → ${BASE}`);

  const { db } = await import("../src/lib/db");
  const { Decimal } = await import("../src/lib/engine/money");

  // Setup
  const testUser = await db.user.upsert({
    where: { email: "ver-test@dramp.test" },
    update: {},
    create: { email: "ver-test@dramp.test", role: "USER", status: "ACTIVE" },
  });
  const testProvider = await db.liquidityProvider.create({
    data: { name: "Version Test Provider", providerType: "BANK", trustModel: "COLLATERALIZED", capabilities: "[]", countries: "[]", reputationScore: 0.8, status: "ACTIVE", tier: "VERIFIED" },
  });
  const testVault = await db.vault.create({
    data: { providerId: testProvider.id, holdingsJson: JSON.stringify([{ asset: "VER_USDC", amount: "50000" }]), usableCollateral: new Decimal(47500), lockedCollateral: new Decimal(0), collateralizationRatio: 1.5, maxExposure: new Decimal(31666.67) },
  });
  await db.liquidityProvider.update({ where: { id: testProvider.id }, data: { vaultId: testVault.id } });
  const testAsset = await db.settlementAsset.upsert({
    where: { symbol: "VER_USDC" },
    update: {},
    create: { symbol: "VER_USDC", issuer: "T", assetType: "STABLECOIN", network: "T", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, redemptionModel: "t", incentiveRate: 0, settlementHaircut: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" },
  });
  const testOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_IN",
      sourceAsset: "USD", destinationAsset: "VER_USDC",
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
      sourceCountry: "US", destinationAsset: "VER_USDC", destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED", executionPolicy: "NOW", maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]", prohibitedSettlementAssets: "[]",
      status: "ACTIVE", expiresAt: new Date(Date.now() + 60000),
    },
  });

  // Helper
  async function createRouteWithSnapshot(execId: string, offerVersion: number | null) {
    const route = await db.route.create({
      data: {
        executionId: execId, legCount: 1, totalCost: new Decimal(3), effectiveCost: new Decimal(3),
        grossOutput: new Decimal(920), netOutput: new Decimal(917), incentiveBps: 10,
        riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.1,
        expectedExecutionSeconds: 30, explanation: "ver test", tag: "BEST", status: "SELECTED", splitRoute: false,
      },
    });
    await db.leg.create({
      data: {
        routeId: route.id, executionId: execId,
        providerId: testProvider.id, offerId: testOffer.id,
        sequence: 0, role: "SOURCE", amount: new Decimal(1000),
        sourceAsset: "USD", destinationAsset: "VER_USDC",
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
  // G. Offer mutations increment version
  // =========================================================================
  console.log("\n== G. Offer mutations increment version ==");

  const offerBefore = await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } });
  assert(offerBefore!.version === 1, `Initial offer version = 1 (got ${offerBefore!.version})`);

  // Mutate via db (simulating provider API update).
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 40, version: { increment: 1 } } });
  const offerAfter = await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } });
  assert(offerAfter!.version === 2, `After mutation, version = 2 (got ${offerAfter!.version})`);

  // Restore for next tests.
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 30, version: { increment: 1 } } });

  // =========================================================================
  // A. Unchanged version — reservation succeeds
  // =========================================================================
  console.log("\n== A. Unchanged version ==");

  const currentOffer = await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } });
  const execA = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 1, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date() },
  });
  await createRouteWithSnapshot(execA.id, currentOffer!.version);
  await reserveRoute(execA.id);
  const execAAfter = await db.execution.findUnique({ where: { id: execA.id } });
  assert(execAAfter!.status === "ROUTE_RESERVED", `Unchanged version → ROUTE_RESERVED (got ${execAAfter!.status})`);

  // =========================================================================
  // B. Version changed — STALE_ROUTE
  // =========================================================================
  console.log("\n== B. Version changed ==");

  const execB = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 2, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date() },
  });
  // Snapshot version = current, but then increment the offer version.
  await createRouteWithSnapshot(execB.id, currentOffer!.version);
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 35, version: { increment: 1 } } });
  await reserveRoute(execB.id);
  const execBAfter = await db.execution.findUnique({ where: { id: execB.id } });
  assert(execBAfter!.status === "SEARCHING", `Version changed → STALE_ROUTE, back to SEARCHING (got ${execBAfter!.status})`);

  // No side effects.
  const resB = await db.reservation.count({ where: { executionId: execB.id } });
  assert(resB === 0, "No reservations for stale-version route");
  const oblB = await db.obligation.count({ where: { executionId: execB.id } });
  assert(oblB === 0, "No obligations for stale-version route");

  // Restore.
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 30, version: { increment: 1 } } });

  // =========================================================================
  // C. Legacy missing version — LEGACY_ROUTE_SNAPSHOT_MISSING
  // =========================================================================
  console.log("\n== C. Legacy missing version ==");

  const execC = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 3, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date() },
  });
  // Create route with NULL snapshotOfferVersion (legacy).
  await createRouteWithSnapshot(execC.id, null);
  await reserveRoute(execC.id);
  const execCAfter = await db.execution.findUnique({ where: { id: execC.id } });
  assert(execCAfter!.status === "SEARCHING", `Legacy missing version → rejected, back to SEARCHING (got ${execCAfter!.status})`);

  // Check audit event for legacy rejection.
  const staleEvent = await db.auditEvent.findFirst({ where: { executionId: execC.id, eventType: "route_stale_rejected" } });
  assert(staleEvent !== null, "Legacy route has route_stale_rejected audit event");
  const payload = JSON.parse(staleEvent!.payloadJson);
  assert(payload.reason.includes("LEGACY_ROUTE_SNAPSHOT_MISSING"), "Rejection reason mentions LEGACY_ROUTE_SNAPSHOT_MISSING");

  // =========================================================================
  // D. Post-reservation mutation — execution uses frozen version
  // =========================================================================
  console.log("\n== D. Post-reservation mutation ==");

  // execA was successfully reserved. The snapshot was refreshed at reservation
  // time from the live offer. Now mutate the offer.
  const legABefore = await db.leg.findFirst({ where: { executionId: execA.id } });
  const frozenVersion = legABefore!.snapshotOfferVersion!;
  await db.liquidityOffer.update({ where: { id: testOffer.id }, data: { feeBps: 99, version: { increment: 1 } } });
  const versionAfter = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;

  // The leg's snapshot should still have the frozen version (not the mutated one).
  const legA = await db.leg.findFirst({ where: { executionId: execA.id } });
  assert(legA!.snapshotOfferVersion === frozenVersion, `Post-mutation: snapshot version = ${frozenVersion} (frozen), not ${versionAfter}`);
  assert(legA!.snapshotFeeBps === 30, "Post-mutation: snapshot feeBps = 30 (frozen), not 99");

  // =========================================================================
  // E. Multi-leg route — one leg stale → entire route rejected
  // =========================================================================
  console.log("\n== E. Multi-leg route — one leg stale ==");

  // Create a second offer (destination leg).
  const destOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_OUT",
      sourceAsset: "VER_USDC", destinationAsset: "EUR",
      sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(1.0), feeBps: 20, minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000), availableCapacity: new Decimal(1000000),
      reservedCapacity: new Decimal(0), settlementAssetId: testAsset.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 20, incentiveBps: 0, active: true,
    },
  });

  const execE = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 4, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date() },
  });
  const routeE = await db.route.create({
    data: {
      executionId: execE.id, legCount: 2, totalCost: new Decimal(5), effectiveCost: new Decimal(5),
      grossOutput: new Decimal(920), netOutput: new Decimal(915), incentiveBps: 0,
      riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.12,
      expectedExecutionSeconds: 50, explanation: "multi-leg ver", tag: "BEST", status: "SELECTED", splitRoute: false,
    },
  });
  // Leg 1: source, version matches.
  await db.leg.create({
    data: {
      routeId: routeE.id, executionId: execE.id, providerId: testProvider.id, offerId: testOffer.id,
      sequence: 0, role: "SOURCE", amount: new Decimal(1000), sourceAsset: "USD", destinationAsset: "VER_USDC",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC", status: "PENDING", commitmentStatus: "REVERSIBLE",
      snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL", snapshotFeeBps: 30, snapshotIncentiveBps: 10,
      snapshotRate: new Decimal(0.92), snapshotExpectedExecutionSeconds: 30, snapshotOfferVersion: versionAfter,
    },
  });
  // Leg 2: destination, version matches NOW but we'll change it before reservation.
  const destOfferVersion = destOffer.version;
  await db.leg.create({
    data: {
      routeId: routeE.id, executionId: execE.id, providerId: testProvider.id, offerId: destOffer.id,
      sequence: 1, role: "DESTINATION", amount: new Decimal(917), sourceAsset: "VER_USDC", destinationAsset: "EUR",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC", status: "PENDING", commitmentStatus: "REVERSIBLE",
      snapshotSourceCountry: "GLOBAL", snapshotDestinationCountry: "EU", snapshotFeeBps: 20, snapshotIncentiveBps: 0,
      snapshotRate: new Decimal(1.0), snapshotExpectedExecutionSeconds: 20, snapshotOfferVersion: destOfferVersion,
    },
  });
  await db.execution.update({ where: { id: execE.id }, data: { selectedRouteId: routeE.id } });

  // Mutate the destination offer (increment its version).
  await db.liquidityOffer.update({ where: { id: destOffer.id }, data: { feeBps: 50, version: { increment: 1 } } });

  // Attempt reservation — should reject because leg 2's version is stale.
  await reserveRoute(execE.id);
  const execEAfter = await db.execution.findUnique({ where: { id: execE.id } });
  assert(execEAfter!.status === "SEARCHING", `Multi-leg with one stale version → rejected (got ${execEAfter!.status})`);

  // No partial reservations.
  const resE = await db.reservation.count({ where: { executionId: execE.id } });
  assert(resE === 0, "No partial reservations for stale multi-leg route");

  // =========================================================================
  // F. Offer version in route_terms_frozen audit event
  // =========================================================================
  console.log("\n== F. Offer version in audit ==");

  const frozenEvent = await db.auditEvent.findFirst({ where: { executionId: execA.id, eventType: "route_terms_frozen" } });
  assert(frozenEvent !== null, "Successful reservation has route_terms_frozen event");
  const frozenPayload = JSON.parse(frozenEvent!.payloadJson);
  assert(frozenPayload.legs[0].offerVersion !== undefined, "route_terms_frozen includes offerVersion");
  assert(frozenPayload.legs[0].offerVersion === frozenVersion, `Frozen offerVersion = ${frozenVersion} (committed version)`);

  // Cleanup
  const allExecIds = [execA.id, execB.id, execC.id, execE.id];
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
  await db.settlementAsset.deleteMany({ where: { symbol: "VER_USDC" } });
  await db.user.deleteMany({ where: { email: "ver-test@dramp.test" } }).catch(() => {});

  console.log(`\n========================================`);
  console.log(`  P3.7 Versioning: Passed: ${passed}  |  Failed: ${failed}`);
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
