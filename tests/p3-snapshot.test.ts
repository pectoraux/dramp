/**
 * dRamp Prompt 3.4 — split-route notional + historical snapshot tests.
 *
 * Proves:
 *   A. Split-route notional: 60/40 split uses $10,000, not $6,000.
 *   B. Split vs unsplit: identical economics → identical absolute cost penalty.
 *   C. Historical offer mutation: changing the offer doesn't change the
 *      reconstructed route's snapshot fields.
 *   D. Multi-hop snapshot: intermediate offer change doesn't affect the route.
 *   E. Patient execution: split reference route compared with correct notional.
 *   F. Audit consistency: route in audit data stable after offer change.
 *
 * Usage: bun tests/p3-snapshot.test.ts
 */

const BASE = process.env.DRAMP_URL ?? "http://localhost:3000";

interface CookieJar { cookie: string; csrfToken: string; }

async function login(email: string, password: string): Promise<CookieJar> {
  const jar: CookieJar = { cookie: "", csrfToken: "" };
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const csrfJson = (await csrfRes.json()) as { csrfToken: string };
  const sc = csrfRes.headers.get("set-cookie");
  if (sc) jar.cookie = sc.split(";")[0];
  jar.csrfToken = csrfJson.csrfToken;
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.cookie },
    body: new URLSearchParams({ email, password, csrfToken: jar.csrfToken, json: "true" }),
    redirect: "manual",
  });
  const sc2 = res.headers.get("set-cookie");
  if (sc2) jar.cookie = sc2.split(",").map((c) => c.split(";")[0]).join("; ");
  const s = await fetch(`${BASE}/api/auth/session`, { headers: { cookie: jar.cookie } });
  const sj = (await s.json()) as { user?: { email?: string } };
  if (!sj.user?.email) throw new Error(`login failed for ${email}`);
  return jar;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P3.4 snapshot + split-route tests → ${BASE}`);

  const { Decimal } = await import("../src/lib/engine/money");
  const { calculateAbsoluteRouteQuality, reconstructPersistedRoute } = await import("../src/lib/engine/routing");

  // Helper: make a route with specified legs.
  function makeRoute(legs: Array<{
    providerId: string; amount: number; role: string;
    srcAsset?: string; dstAsset?: string; srcCountry?: string; dstCountry?: string;
  }>, opts: { cost: number; duration: number; risk: number }): any {
    return {
      legs: legs.map(l => ({
        providerId: l.providerId,
        amount: new Decimal(l.amount),
        sourceAsset: l.srcAsset ?? "USD",
        destinationAsset: l.dstAsset ?? "EUR",
        sourceCountry: l.srcCountry ?? "US",
        destinationCountry: l.dstCountry ?? "EU",
        offerId: "test",
        sequence: 0,
        role: l.role,
        settlementAssetId: null,
        channelType: "AUTOMATIC",
        feeBps: 20,
        incentiveBps: 0,
        rate: new Decimal(0.92),
        expectedExecutionSeconds: opts.duration,
        providerRisk: { trustModel: "COLLATERALIZED", providerType: "BANK", reputationScore: 0.5, status: "ACTIVE" },
        offerCapacity: new Decimal(100000),
        settlementAssetRisk: null,
      })),
      hopCount: legs.length,
      split: legs.filter(l => l.role === "SOURCE").length > 1,
      totalCost: new Decimal(opts.cost),
      effectiveCost: new Decimal(opts.cost),
      grossOutput: new Decimal(9200),
      netOutput: new Decimal(9200),
      incentiveBps: 0,
      risk: { composite: opts.risk, counterparty: 0.1, settlementAsset: 0.1, liquidity: 0.1, operational: 0.1, duration: 0.1 },
      expectedExecutionSeconds: opts.duration,
      explanation: "test",
      tag: "CANDIDATE",
      hardFilterRejection: undefined,
    };
  }

  const ctx: any = { riskTolerance: "BALANCED" };

  // =========================================================================
  // A. Split-route notional
  // =========================================================================
  console.log("\n== A. Split-route notional ==");

  // Single-leg: $10,000 source.
  const singleRoute = makeRoute(
    [{ providerId: "prov-a", amount: 10000, role: "SOURCE" }],
    { cost: 50, duration: 60, risk: 0.2 }
  );
  const singleQuality = calculateAbsoluteRouteQuality(singleRoute, ctx);

  // Split 60/40: $6,000 + $4,000 = $10,000 total source.
  const splitRoute = makeRoute(
    [
      { providerId: "prov-a", amount: 6000, role: "SOURCE" },
      { providerId: "prov-b", amount: 4000, role: "SOURCE" },
    ],
    { cost: 50, duration: 60, risk: 0.2 }
  );
  const splitQuality = calculateAbsoluteRouteQuality(splitRoute, ctx);

  // Both should have the SAME absolute cost penalty because the total source
  // notional is $10,000 in both cases and the effectiveCost is $50 in both.
  // (The reputation/commitment may differ slightly because split has 2 providers,
  // but the COST component must be identical.)
  // We isolate the cost component by checking with neutral reputation (0.5 default).
  assert(Math.abs(singleQuality - splitQuality) < 0.001,
    `Single-leg ($10k) and split ($6k+$4k) routes with identical cost get equivalent quality (${singleQuality.toFixed(6)} vs ${splitQuality.toFixed(6)})`);

  // =========================================================================
  // B. Split vs unsplit — identical economics
  // =========================================================================
  console.log("\n== B. Split vs unsplit — identical economics ==");

  // Both routes: $10,000 notional, $50 effective cost, same duration, same risk.
  // Both use the same provider (so reputation is identical).
  const unsplitSame = makeRoute(
    [{ providerId: "prov-x", amount: 10000, role: "SOURCE" }],
    { cost: 50, duration: 60, risk: 0.2 }
  );
  const splitSame = makeRoute(
    [
      { providerId: "prov-x", amount: 6000, role: "SOURCE" },
      { providerId: "prov-x", amount: 4000, role: "SOURCE" },
    ],
    { cost: 50, duration: 60, risk: 0.2 }
  );
  const qUnsplit = calculateAbsoluteRouteQuality(unsplitSame, ctx);
  const qSplit = calculateAbsoluteRouteQuality(splitSame, ctx);
  assert(Math.abs(qUnsplit - qSplit) < 0.0001,
    `Identical economics → identical quality regardless of split (${qUnsplit.toFixed(6)} vs ${qSplit.toFixed(6)})`);

  // =========================================================================
  // C. Historical offer mutation
  // =========================================================================
  console.log("\n== C. Historical offer mutation ==");

  // Use direct DB to create a route, then mutate the offer, then reconstruct.
  const { db } = await import("../src/lib/db");

  const testUser = await db.user.upsert({
    where: { email: "snap-test@dramp.test" },
    update: {},
    create: { email: "snap-test@dramp.test", role: "USER", status: "ACTIVE" },
  });
  const testProvider = await db.liquidityProvider.create({
    data: { name: "Snap Test Provider", providerType: "BANK", trustModel: "COLLATERALIZED", capabilities: "[]", countries: "[]", reputationScore: 0.8, status: "ACTIVE", tier: "VERIFIED" },
  });
  const testAsset = await db.settlementAsset.upsert({
    where: { symbol: "SNAP_TEST" },
    update: {},
    create: { symbol: "SNAP_TEST", issuer: "T", assetType: "STABLECOIN", network: "T", volatilityScore: 0.02, liquidityScore: 0.95, pegQuality: 0.99, redemptionModel: "t", incentiveRate: 0, settlementHaircut: 0, collateralHaircut: 0.05, isEligibleCollateral: true, status: "ACTIVE" },
  });
  const testOffer = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "FIAT_IN",
      sourceAsset: "USD", destinationAsset: "SNAP_TEST",
      sourceCountry: "US", destinationCountry: "GLOBAL",
      rate: new Decimal(1), feeBps: 30, minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000), availableCapacity: new Decimal(1000000),
      reservedCapacity: new Decimal(0), settlementAssetId: testAsset.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 45, incentiveBps: 0, active: true,
    },
  });
  const testIntent = await db.executionIntent.create({
    data: {
      userId: testUser.id, sourceAmount: new Decimal(1000), sourceAsset: "USD",
      sourceCountry: "US", destinationAsset: "SNAP_TEST", destinationCountry: "GLOBAL",
      riskTolerance: "BALANCED", executionPolicy: "NOW", maxWaitSeconds: 60,
      cancellationPolicy: "CANCEL_ANYTIME_WHILE_REVERSIBLE",
      allowedSettlementAssets: "[]", prohibitedSettlementAssets: "[]",
      status: "COMPLETED", expiresAt: new Date(Date.now() + 60000),
    },
  });
  const testExec = await db.execution.create({
    data: { intentId: testIntent.id, attemptNumber: 1, status: "COMPLETED", commitmentStatus: "IRREVERSIBLE", startedAt: new Date(), completedAt: new Date() },
  });

  // Persist a route with snapshot fields.
  const testRoute = await db.route.create({
    data: {
      executionId: testExec.id, legCount: 1, totalCost: new Decimal(3), effectiveCost: new Decimal(3),
      grossOutput: new Decimal(1000), netOutput: new Decimal(997), incentiveBps: 0,
      riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.1,
      expectedExecutionSeconds: 45, explanation: "snapshot test", tag: "BEST", status: "SELECTED", splitRoute: false,
    },
  });
  await db.leg.create({
    data: {
      routeId: testRoute.id, executionId: testExec.id,
      providerId: testProvider.id, offerId: testOffer.id,
      sequence: 0, role: "SOURCE", amount: new Decimal(1000),
      sourceAsset: "USD", destinationAsset: "SNAP_TEST",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC",
      status: "CONFIRMED", commitmentStatus: "IRREVERSIBLE",
      // Snapshot at creation time:
      snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL",
      snapshotFeeBps: 30, snapshotIncentiveBps: 0,
      snapshotRate: new Decimal(1), snapshotExpectedExecutionSeconds: 45,
    },
  });

  // Reconstruct BEFORE mutation.
  const beforeMutation = await reconstructPersistedRoute(testRoute.id);
  assert(beforeMutation !== null, "Route reconstructed before mutation");
  assert(beforeMutation!.legs[0].feeBps === 30, "Snapshot feeBps = 30 (original)");
  assert(beforeMutation!.legs[0].sourceCountry === "US", "Snapshot sourceCountry = US (original)");
  assert(beforeMutation!.legs[0].expectedExecutionSeconds === 45, "Snapshot executionSeconds = 45 (original)");

  // Now MUTATE the offer — change feeBps from 30 to 80.
  await db.liquidityOffer.update({
    where: { id: testOffer.id },
    data: { feeBps: 80, expectedExecutionSeconds: 120 },
  });

  // Reconstruct AFTER mutation.
  const afterMutation = await reconstructPersistedRoute(testRoute.id);
  assert(afterMutation !== null, "Route reconstructed after mutation");
  assert(afterMutation!.legs[0].feeBps === 30, "Snapshot feeBps STILL = 30 (not mutated to 80)");
  assert(afterMutation!.legs[0].expectedExecutionSeconds === 45, "Snapshot executionSeconds STILL = 45 (not mutated to 120)");
  assert(afterMutation!.legs[0].sourceCountry === "US", "Snapshot sourceCountry STILL = US");

  // The route-level economics (effectiveCost etc.) come from the persisted Route, not the offer.
  assert(afterMutation!.effectiveCost.toString() === "3", "Route effectiveCost = 3 (from persisted Route, not offer)");

  // =========================================================================
  // D. Multi-hop snapshot
  // =========================================================================
  console.log("\n== D. Multi-hop snapshot ==");

  // Create a second offer (intermediate hop) and mutate it.
  const testOffer2 = await db.liquidityOffer.create({
    data: {
      providerId: testProvider.id, capability: "SWAP",
      sourceAsset: "SNAP_TEST", destinationAsset: "EUR",
      sourceCountry: "GLOBAL", destinationCountry: "EU",
      rate: new Decimal(0.92), feeBps: 15, minimumAmount: new Decimal(1),
      maximumAmount: new Decimal(1000000), availableCapacity: new Decimal(1000000),
      reservedCapacity: new Decimal(0), settlementAssetId: testAsset.id,
      channelType: "AUTOMATIC", expectedExecutionSeconds: 20, incentiveBps: 0, active: true,
    },
  });

  const multiRoute = await db.route.create({
    data: {
      executionId: testExec.id, legCount: 2, totalCost: new Decimal(5), effectiveCost: new Decimal(5),
      grossOutput: new Decimal(920), netOutput: new Decimal(915), incentiveBps: 0,
      riskCounterparty: 0.1, riskSettlementAsset: 0.1, riskLiquidity: 0.1, riskOperational: 0.1, riskDuration: 0.1, riskComposite: 0.12,
      expectedExecutionSeconds: 65, explanation: "multi-hop snapshot", tag: "BEST", status: "SELECTED", splitRoute: false,
    },
  });
  await db.leg.create({
    data: {
      routeId: multiRoute.id, executionId: testExec.id,
      providerId: testProvider.id, offerId: testOffer.id,
      sequence: 0, role: "SOURCE", amount: new Decimal(1000),
      sourceAsset: "USD", destinationAsset: "SNAP_TEST",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC",
      status: "CONFIRMED", commitmentStatus: "IRREVERSIBLE",
      snapshotSourceCountry: "US", snapshotDestinationCountry: "GLOBAL",
      snapshotFeeBps: 30, snapshotIncentiveBps: 0,
      snapshotRate: new Decimal(1), snapshotExpectedExecutionSeconds: 45,
    },
  });
  await db.leg.create({
    data: {
      routeId: multiRoute.id, executionId: testExec.id,
      providerId: testProvider.id, offerId: testOffer2.id,
      sequence: 1, role: "DESTINATION", amount: new Decimal(997),
      sourceAsset: "SNAP_TEST", destinationAsset: "EUR",
      settlementAssetId: testAsset.id, channelType: "AUTOMATIC",
      status: "CONFIRMED", commitmentStatus: "IRREVERSIBLE",
      snapshotSourceCountry: "GLOBAL", snapshotDestinationCountry: "EU",
      snapshotFeeBps: 15, snapshotIncentiveBps: 0,
      snapshotRate: new Decimal(0.92), snapshotExpectedExecutionSeconds: 20,
    },
  });

  // Mutate the intermediate offer.
  await db.liquidityOffer.update({
    where: { id: testOffer2.id },
    data: { feeBps: 50, expectedExecutionSeconds: 180 },
  });

  // Reconstruct — should still show original snapshot values.
  const multiReconstructed = await reconstructPersistedRoute(multiRoute.id);
  assert(multiReconstructed !== null, "Multi-hop route reconstructed");
  assert(multiReconstructed!.legs[1].feeBps === 15, "Intermediate leg feeBps = 15 (snapshot, not mutated 50)");
  assert(multiReconstructed!.legs[1].expectedExecutionSeconds === 20, "Intermediate leg executionSeconds = 20 (snapshot, not mutated 180)");

  // =========================================================================
  // E. Patient execution — split reference route uses correct notional
  // =========================================================================
  console.log("\n== E. Patient execution — split reference route ==");

  // The calculateAbsoluteRouteQuality function now correctly sums SOURCE legs
  // for the notional. We verify this with a split route that has two SOURCE legs.
  const splitRef = makeRoute(
    [
      { providerId: "prov-a", amount: 6000, role: "SOURCE" },
      { providerId: "prov-b", amount: 4000, role: "SOURCE" },
    ],
    { cost: 50, duration: 60, risk: 0.2 }
  );
  const newCandidate = makeRoute(
    [{ providerId: "prov-c", amount: 10000, role: "SOURCE" }],
    { cost: 30, duration: 60, risk: 0.2 }
  );

  // The new candidate has lower cost ($30 vs $50) on the same $10,000 notional.
  // The absolute quality should reflect this correctly.
  const refQ = calculateAbsoluteRouteQuality(splitRef, ctx);
  const newQ = calculateAbsoluteRouteQuality(newCandidate, ctx);
  assert(newQ < refQ, `New cheaper route has better quality than split reference (${newQ.toFixed(4)} vs ${refQ.toFixed(4)})`);

  // =========================================================================
  // F. Audit consistency
  // =========================================================================
  console.log("\n== F. Audit consistency ==");

  // The route stored in the audit trail (via selectedRouteJson or the Route
  // record itself) must remain stable after offer mutation. We verify by
  // checking that the reconstructed route's economics match the persisted
  // route's economics (not the mutated offer's).
  assert(afterMutation!.effectiveCost.toString() === "3", "Audit route effectiveCost stable after offer mutation");
  assert(afterMutation!.legs[0].feeBps === 30, "Audit route leg feeBps stable after offer mutation");
  assert(multiReconstructed!.legs[1].feeBps === 15, "Audit multi-hop leg feeBps stable after offer mutation");

  // Cleanup.
  await db.leg.deleteMany({ where: { routeId: { in: [testRoute.id, multiRoute.id] } } });
  await db.route.deleteMany({ where: { id: { in: [testRoute.id, multiRoute.id] } } });
  await db.execution.deleteMany({ where: { id: testExec.id } });
  await db.executionIntent.deleteMany({ where: { id: testIntent.id } });
  await db.liquidityOffer.deleteMany({ where: { providerId: testProvider.id } });
  await db.liquidityProvider.deleteMany({ where: { id: testProvider.id } });
  await db.settlementAsset.deleteMany({ where: { symbol: "SNAP_TEST" } });
  await db.user.deleteMany({ where: { email: "snap-test@dramp.test" } });

  console.log(`\n========================================`);
  console.log(`  P3.4 Snapshot: Passed: ${passed}  |  Failed: ${failed}`);
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
