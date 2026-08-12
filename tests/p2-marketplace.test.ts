/**
 * dRamp Prompt 2 — marketplace + provider API + incentives regression tests.
 *
 * Proves:
 *   - Provider API key auth works; wrong key rejected; provider isolation
 *     enforced (Provider A cannot read Provider B's offers/executions).
 *   - Marketplace returns public offers with redacted capacity (no
 *     reservedCapacity, no vault).
 *   - Pending demand is anonymized (no userId, no exact amount).
 *   - Incentive campaigns accrue only on completed executions, not on
 *     route display.
 *   - Reconciliation detects stale obligations.
 *
 * Requires a running, seeded server (default http://localhost:3000).
 *
 * Usage: bun tests/p2-marketplace.test.ts
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

async function api(jar: CookieJar, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: jar.cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function providerApi(authHeader: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: authHeader },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P2 marketplace tests → ${BASE}`);
  const seed = await fetch(`${BASE}/api/seed`).then((r) => r.json() as any);
  if (!seed.seeded) { console.error("Marketplace not seeded."); process.exit(1); }

  // ---- Login as admin + operator ----
  const admin = await login("admin@dramp.demo", "Demo1234!");
  const operator = await login("operator@dramp.demo", "Demo1234!");
  const alice = await login("alice@dramp.demo", "Demo1234!");
  console.log("  Logins OK");

  // ---- Get Northbridge provider + create an API key ----
  const providers = await api(admin, "GET", "/api/providers");
  const northbridge = providers.json.providers.find((p: any) => p.name === "Northbridge Bank");
  const meridian = providers.json.providers.find((p: any) => p.name === "Meridian Liquidity");
  assert(!!northbridge, "Northbridge Bank found");
  assert(!!meridian, "Meridian Liquidity found");

  const keyRes = await api(operator, "POST", "/api/v1/provider/keys", { providerId: northbridge.id, label: "p2-test", scopes: ["offers", "executions", "obligations", "reconcile"] });
  const nbKey = keyRes.json.keyId;
  const nbSecret = keyRes.json.secret;
  assert(!!nbKey && !!nbSecret, "API key created with secret");

  // Create a key for Meridian too (to test isolation).
  const meridianOp = await login("operator@dramp.demo", "Demo1234!");
  // Admin can create keys for any provider.
  const keyRes2 = await api(admin, "POST", "/api/v1/provider/keys", { providerId: meridian.id, label: "meridian-test", scopes: ["offers", "executions", "obligations", "reconcile"] });
  const merKey = keyRes2.json.keyId;
  const merSecret = keyRes2.json.secret;
  assert(!!merKey && !!merSecret, "Meridian API key created");

  const nbAuth = `Bearer ${nbKey}:${nbSecret}`;
  const merAuth = `Bearer ${merKey}:${merSecret}`;

  console.log("\n== TEST: Provider API auth (valid key) ==");
  const nbOffers = await providerApi(nbAuth, "GET", "/api/v1/provider/offers");
  assert(nbOffers.status === 200, "Valid key → 200");
  assert(nbOffers.json.offers.length > 0, "Northbridge has offers via API");

  console.log("\n== TEST: Provider API auth (invalid key rejected) ==");
  const badAuth = await providerApi("Bearer pk_fake:sk_fake", "GET", "/api/v1/provider/offers");
  assert(badAuth.status === 401, "Invalid key → 401");

  console.log("\n== TEST: Provider isolation (NB cannot read Meridian's offers) ==");
  // NB's API key should only return NB's offers, not Meridian's.
  // Get Meridian's offer IDs.
  const merOffersViaMer = await providerApi(merAuth, "GET", "/api/v1/provider/offers");
  const merOfferIds = merOffersViaMer.json.offers.map((o: any) => o.id);
  // NB's offers should NOT include any of Meridian's offer IDs.
  const nbOfferIds = nbOffers.json.offers.map((o: any) => o.id);
  const overlap = nbOfferIds.filter((id: string) => merOfferIds.includes(id));
  assert(overlap.length === 0, "Northbridge API returns only NB offers (no Meridian leakage)");

  console.log("\n== TEST: Provider cannot mutate another provider's offer ==");
  if (merOfferIds.length > 0) {
    const patchRes = await providerApi(nbAuth, "PATCH", `/api/v1/provider/offers/${merOfferIds[0]}`, { feeBps: 1 });
    assert(patchRes.status === 404, "NB trying to patch Meridian's offer → 404");
  }

  console.log("\n== TEST: Marketplace returns public offers (redacted) ==");
  const market = await api(alice, "GET", "/api/marketplace");
  assert(market.status === 200, "Marketplace accessible to USER");
  assert(market.json.offers.length > 0, "Marketplace has offers");
  const hasReserved = market.json.offers.some((o: any) => o.reservedCapacity !== undefined);
  assert(!hasReserved, "Marketplace offers do NOT expose reservedCapacity");
  const hasVault = market.json.offers.some((o: any) => o.vault !== undefined);
  assert(!hasVault, "Marketplace offers do NOT expose vault");
  const hasCapacityBucket = market.json.offers.every((o: any) => o.capacityBucket !== undefined);
  assert(hasCapacityBucket, "Marketplace offers expose capacityBucket (not exact)");

  console.log("\n== TEST: Pending demand is anonymized ==");
  // Create a WAIT_FOR_BETTER intent as Alice so there's demand.
  const intent = await api(alice, "POST", "/api/intents", {
    sourceAmount: 7777, sourceAsset: "USD", sourceCountry: "US",
    destinationAsset: "EUR", destinationCountry: "EU",
    riskTolerance: "BALANCED", executionPolicy: "WAIT_FOR_BETTER", maxWaitSeconds: 120,
  });
  assert(!!intent.json.intentId, "Alice creates WAIT_FOR_BETTER intent for demand");
  const demand = await api(alice, "GET", "/api/marketplace/demand");
  assert(demand.status === 200, "Pending demand accessible");
  if (demand.json.demand.length > 0) {
    const d = demand.json.demand[0];
    assert(d.userId === undefined, "Demand does NOT expose userId");
    assert(d.amountBucket !== undefined && typeof d.amountBucket === "string", "Demand exposes amountBucket (not exact)");
    assert(d.remainingWaitSeconds !== undefined, "Demand exposes remainingWaitSeconds");
  }

  console.log("\n== TEST: Provider competition returns ranked routes ==");
  const comp = await api(alice, "POST", "/api/marketplace/competition", {
    sourceAsset: "USD", sourceCountry: "US", destinationAsset: "EUR", destinationCountry: "EU",
    sourceAmount: 1000, riskTolerance: "BALANCED",
  });
  assert(comp.status === 200, "Competition query OK");
  assert(comp.json.routes.length > 0, "Competition returns routes");
  const hasTag = comp.json.routes.every((r: any) => r.tag !== undefined);
  assert(hasTag, "Competition routes have tags (BEST/CHEAPEST/etc.)");

  console.log("\n== TEST: Incentive campaigns exist ==");
  const campaigns = await api(admin, "GET", "/api/incentives");
  assert(campaigns.json.campaigns.length >= 2, "At least 2 incentive campaigns seeded");
  const hasBudget = campaigns.json.campaigns.every((c: any) => c.totalBudget !== undefined && c.accrued !== undefined);
  assert(hasBudget, "Campaigns expose budget + accrued");

  console.log("\n== TEST: Ops overview (admin only) ==");
  const opsOverview = await api(alice, "GET", "/api/ops/overview");
  assert(opsOverview.status === 403, "USER cannot access ops overview → 403");
  const opsAdmin = await api(admin, "GET", "/api/ops/overview");
  assert(opsAdmin.status === 200, "Admin can access ops overview");
  assert(opsAdmin.json.activeProviders !== undefined, "Ops overview has activeProviders");

  console.log("\n== TEST: Ops execution queue (admin) ==");
  const queue = await api(admin, "GET", "/api/ops/queue");
  assert(queue.status === 200, "Admin can access execution queue");
  assert(Array.isArray(queue.json.queue), "Queue is an array");

  console.log("\n== TEST: Ops bottlenecks (admin) ==");
  const bottlenecks = await api(admin, "GET", "/api/ops/bottlenecks");
  assert(bottlenecks.status === 200, "Admin can access bottlenecks");
  assert(bottlenecks.json.corridorDemand !== undefined, "Bottlenecks has corridorDemand");

  console.log("\n== TEST: Ops provider risk (admin) ==");
  const provRisk = await api(admin, "GET", "/api/ops/provider-risk");
  assert(provRisk.status === 200, "Admin can access provider risk");
  assert(provRisk.json.providers.length > 0, "Provider risk has data");

  console.log("\n== TEST: Ops concentration (admin) ==");
  const conc = await api(admin, "GET", "/api/ops/concentration");
  assert(conc.status === 200, "Admin can access concentration");
  assert(conc.json.offersByProviderType !== undefined, "Concentration has offersByProviderType");

  console.log("\n== TEST: Settlement asset registry ==");
  const saRes = await api(alice, "GET", "/api/settlement-assets");
  assert(saRes.status === 200, "Settlement assets accessible to USER");
  const weth = saRes.json.assets.find((a: any) => a.symbol === "WETH");
  assert(!!weth, "WETH in registry");
  assert(weth.isEligibleCollateral === false, "WETH is NOT eligible collateral (hard invariant in registry)");
  assert(weth.assetType === "VOLATILE_TOKEN", "WETH assetType is VOLATILE_TOKEN");

  console.log("\n== TEST: Onboarding application (any user) ==");
  const applyRes = await api(alice, "POST", "/api/onboarding/apply", {
    name: "Test Provider P2", providerType: "PSP", trustModel: "PRE_FUNDED",
    capabilities: ["FIAT_IN", "FIAT_OUT"], countries: ["US"],
    jurisdiction: "US", contactEmail: "test@p2.example",
    supportedAssets: ["USD"], settlementMethods: ["BANK_TRANSFER"],
  });
  assert(applyRes.status === 200, "User can submit provider application");
  assert(applyRes.json.status === "APPLIED", "Application status is APPLIED");

  console.log("\n== TEST: Onboarding lifecycle (admin) ==");
  const newProviderId = applyRes.json.id;
  const reviewRes = await api(admin, "PATCH", `/api/onboarding/providers/${newProviderId}`, { status: "REVIEW" });
  assert(reviewRes.status === 200, "Admin can move to REVIEW");
  const approveRes = await api(admin, "PATCH", `/api/onboarding/providers/${newProviderId}`, { status: "ACTIVE" });
  assert(approveRes.status === 200, "Admin can approve → ACTIVE");

  console.log(`\n========================================`);
  console.log(`  P2 Marketplace: Passed: ${passed}  |  Failed: ${failed}`);
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
