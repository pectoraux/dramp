/**
 * dRamp Prompt 3.8b — concurrent offer-update vs reservation integration test.
 *
 * Races reserveRoute() against a provider offer update through the actual
 * mutation path (db.liquidityOffer.update with version increment).
 *
 * Valid outcomes:
 *   A wins: reservation commits version N, B subsequently updates to N+1.
 *   B wins: A receives STALE_ROUTE, no reservation/collateral/obligation.
 *
 * Invalid outcome:
 *   A commits against N while B's update to N+1 has already won.
 *
 * Usage: bun tests/p3-concurrent-offer.test.ts
 */

const BASE = process.env.DRAMP_URL ?? "http://localhost:3000";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P3.8b concurrent offer-update vs reservation → ${BASE}`);

  const { db } = await import("../src/lib/db");
  const { Decimal } = await import("../src/lib/engine/money");
  const { reserveRoute } = await import("../src/lib/engine/execution");

  // Setup
  const testUser = await db.user.upsert({
    where: { email: "conc-offer@dramp.test" },
    update: {},
    create: { email: "conc-offer@dramp.test", role: "USER", status: "ACTIVE" },
  });
  const testProvider = await db.liquidityProvider.create({
    data: { name: "Concurrent Offer Provider", providerType: "BANK", trustModel: "COLLATERALIZED", capabilities: "[]", countries: "[]", reputationScore: 0.8, status: "ACTIVE", tier: "VERIFIED" },
  });
  const testVault = await db.vault.create({
    data: { providerId: testProvider.id, holdingsJson: JSON.stringify([{ asset: "CONC_USDC", amount: "50000" }]), usableCollateral: new Decimal(47500), lockedCollateral: new Decimal(0), collateralizationRatio: 1.5, maxExposure: new Decimal(31666.67) },
  });
  await db.liquidityProvider.update({ where: { id: testProvider.id }, data: { vaultId: testVault.id } });
  const testAsset = await db.settlementAsset.upsert({
    where: { symbol: "CONC_USDC" },
    update: {},
    create: { symbol: "CONC_USDC", issuer: "T", assetType: "STABLECOIN", network: "T", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, redemptionModel: "t", incentiveRate: 0, settlementHaircut: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" },
  });
  const testOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_IN",
      sourceAsset: "USD", destinationAsset: "CONC_USDC",
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
      sourceCountry: "US", destinationAsset: "CONC_USDC", destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED", executionPolicy: "NOW", maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]", prohibitedSettlementAssets: "[]",
      status: "ACTIVE", expiresAt: new Date(Date.now() + 60000),
    },
  });

  // Run the race 5 times to increase the chance of hitting the concurrency window.
  for (let run = 0; run < 5; run++) {
    console.log(`\n== Run ${run + 1}: concurrent reservation vs offer update ==`);

    // Reset the offer to a known state for each run.
    await db.liquidityOffer.update({
      where: { id: testOffer.id },
      data: { feeBps: 30, rate: new Decimal(0.92), version: 1 + run * 10 },
    });
    const baseVersion = (await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true } }))!.version;

    // Create an execution with a route snapshot at the current version.
    const exec = await db.execution.create({
      data: { intentId: testIntent.id, attemptNumber: run + 1, status: "ROUTE_FOUND", commitmentStatus: "REVERSIBLE", startedAt: new Date(), lastTickAt: new Date(Date.now() + 120000) },
    });
    const route = await db.route.create({
      data: {
        executionId: exec.id, legCount: 1, totalCost: new Decimal(3), effectiveCost: new Decimal(3),
        grossOutput: new Decimal(920), netOutput: new Decimal(917), incentiveBps: 10,
        riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.1,
        expectedExecutionSeconds: 30, explanation: "concurrent test", tag: "BEST", status: "SELECTED", splitRoute: false,
      },
    });
    await db.leg.create({
      data: {
        routeId: route.id, executionId: exec.id, providerId: testProvider.id, offerId: testOffer.id,
        sequence: 0, role: "SOURCE", amount: new Decimal(1000), sourceAsset: "USD", destinationAsset: "CONC_USDC",
        settlementAssetId: testAsset.id, channelType: "AUTOMATIC", status: "PENDING", commitmentStatus: "REVERSIBLE",
        snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL", snapshotFeeBps: 30, snapshotIncentiveBps: 10,
        snapshotRate: new Decimal(0.92), snapshotExpectedExecutionSeconds: 30, snapshotOfferVersion: baseVersion,
      },
    });
    await db.execution.update({ where: { id: exec.id }, data: { selectedRouteId: route.id } });

    // Race: Transaction A (reserveRoute) vs Transaction B (offer update).
    // Both start simultaneously. The CAS in reserveRoute will either:
    //   - succeed (A wins) → B's update either fails (version mismatch) or applies after
    //   - fail (B wins) → A gets STALE_ROUTE, no side effects
    const [reserveResult, updateResult] = await Promise.allSettled([
      reserveRoute(exec.id),
      // Simulate the provider API mutation path: update with version increment.
      db.liquidityOffer.update({
        where: { id: testOffer.id, version: baseVersion },
        data: { feeBps: 80, version: { increment: 1 } },
      }),
    ]);

    const execAfter = await db.execution.findUnique({ where: { id: exec.id } });
    const offerAfter = await db.liquidityOffer.findUnique({ where: { id: testOffer.id }, select: { version: true, feeBps: true } });

    const reservationSucceeded = execAfter!.status !== "SEARCHING";
    const updateSucceeded = updateResult.status === "fulfilled";

    if (reservationSucceeded) {
      // Outcome A: reservation won.
      // The CAS incremented the offer version, so B's conditional update
      // (WHERE version = baseVersion) should have failed (0 rows).
      assert(!updateSucceeded, `Run ${run + 1}: Reservation won → offer update should fail (version mismatch)`);
      // The execution should have advanced past ROUTE_FOUND.
      assert(execAfter!.status === "ROUTE_RESERVED" || execAfter!.status === "ORIGIN_PENDING" || execAfter!.status === "COMPLETED",
        `Run ${run + 1}: Reservation won → status = ${execAfter!.status}`);
      // The offer version should have been incremented by the CAS.
      assert(offerAfter!.version === baseVersion + 1, `Run ${run + 1}: Reservation won → offer version = ${baseVersion + 1} (CAS increment)`);
      // The leg snapshot should still have the observed version.
      const leg = await db.leg.findFirst({ where: { executionId: exec.id } });
      assert(leg!.snapshotOfferVersion === baseVersion, `Run ${run + 1}: snapshotOfferVersion = ${baseVersion} (observed, not incremented)`);
      // The committed feeBps should be the observed 30, not the attempted 80.
      assert(leg!.snapshotFeeBps === 30, `Run ${run + 1}: snapshotFeeBps = 30 (committed), not 80 (attempted mutation)`);
      console.log(`  Run ${run + 1}: Reservation won (CAS succeeded, offer update rejected)`);
    } else {
      // Outcome B: offer update won.
      // The offer update should have succeeded (version incremented).
      assert(updateSucceeded, `Run ${run + 1}: Offer update won → update should succeed`);
      // The reservation should have been rejected (STALE_ROUTE).
      assert(execAfter!.status === "SEARCHING", `Run ${run + 1}: Offer update won → execution back to SEARCHING`);
      // No side effects from the reservation.
      const reservations = await db.reservation.count({ where: { executionId: exec.id } });
      assert(reservations === 0, `Run ${run + 1}: Offer update won → no reservations`);
      const obligations = await db.obligation.count({ where: { executionId: exec.id } });
      assert(obligations === 0, `Run ${run + 1}: Offer update won → no obligations`);
      // The offer should have the mutated feeBps.
      assert(offerAfter!.feeBps === 80, `Run ${run + 1}: Offer update won → feeBps = 80 (mutated)`);
      console.log(`  Run ${run + 1}: Offer update won (CAS failed, reservation rejected)`);
    }

    // INVALID: both succeeded (mixed economics).
    assert(!(reservationSucceeded && updateSucceeded), `Run ${run + 1}: INVALID — both reservation and offer update succeeded (mixed economics)`);

    // Cleanup this run's execution.
    await db.collateralLock.deleteMany({ where: { executionId: exec.id } });
    await db.reservation.deleteMany({ where: { executionId: exec.id } });
    await db.obligation.deleteMany({ where: { executionId: exec.id } });
    await db.auditEvent.deleteMany({ where: { executionId: exec.id } });
    await db.leg.deleteMany({ where: { executionId: exec.id } });
    await db.route.deleteMany({ where: { executionId: exec.id } });
    await db.execution.deleteMany({ where: { id: exec.id } });
  }

  // Final cleanup.
  await db.execution.deleteMany({ where: { intentId: testIntent.id } });
  await db.executionIntent.deleteMany({ where: { id: testIntent.id } });
  await db.liquidityOffer.deleteMany({ where: { providerId: testProvider.id } });
  await db.vault.deleteMany({ where: { providerId: testProvider.id } });
  await db.liquidityProvider.deleteMany({ where: { id: testProvider.id } });
  await db.settlementAsset.deleteMany({ where: { symbol: "CONC_USDC" } });
  await db.user.deleteMany({ where: { email: "conc-offer@dramp.test" } }).catch(() => {});

  console.log(`\n========================================`);
  console.log(`  P3.8b Concurrent Offer: Passed: ${passed}  |  Failed: ${failed}`);
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
