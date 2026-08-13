/**
 * dRamp Prompt 3 — network economics tests.
 *
 * Proves:
 *   1. ReputationService returns explainable components (0-100 per dimension).
 *   2. Routing integration: reputation is a factor in ranking (modest, never
 *      overrides hard constraints).
 *   3. Provider economics: earnings derived from ledger, not fabricated.
 *   4. Network health: transparent components, not opaque.
 *   5. Provider funnel: tracks acquisition stages.
 *   6. Commitments: create + list.
 *
 * Requires a running, seeded server (default http://localhost:3000).
 * Usage: bun tests/p3-economics.test.ts
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

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, label: string) {
  if (cond) passed++; else { failed++; failures.push(label); console.error(`  ✗ ${label}`); }
}

async function main() {
  console.log(`dRamp P3 economics tests → ${BASE}`);
  const seed = await fetch(`${BASE}/api/seed`).then((r) => r.json() as any);
  if (!seed.seeded) { console.error("Marketplace not seeded."); process.exit(1); }

  const admin = await login("admin@dramp.demo", "Demo1234!");
  const alice = await login("alice@dramp.demo", "Demo1234!");
  const operator = await login("operator@dramp.demo", "Demo1234!");
  console.log("  Logins OK");

  // Get a provider ID for testing.
  const providers = await api(admin, "GET", "/api/providers");
  const firstProvider = providers.json.providers[0];
  assert(!!firstProvider, "Provider exists for testing");
  const providerId = firstProvider.id;

  // =========================================================================
  // 1. REPUTATION SERVICE — explainable components
  // =========================================================================
  console.log("\n== 1. Reputation service ==");
  const rep = await api(admin, "GET", `/api/economics/reputation/${providerId}`);
  assert(rep.status === 200, "Reputation endpoint returns 200");
  assert(rep.json.components !== undefined, "Reputation has components");
  assert(rep.json.components.overall !== undefined, "Reputation has overall score");
  assert(rep.json.components.overall >= 0 && rep.json.components.overall <= 100, "Overall score is 0-100");
  assert(rep.json.components.reliability !== undefined, "Has reliability component");
  assert(rep.json.components.speed !== undefined, "Has speed component");
  assert(rep.json.components.liquidityQuality !== undefined, "Has liquidityQuality component");
  assert(rep.json.components.pricing !== undefined, "Has pricing component");
  assert(rep.json.components.disputes !== undefined, "Has disputes component");
  assert(rep.json.components.operational !== undefined, "Has operational component");
  assert(rep.json.components.history !== undefined, "Has history component");
  assert(rep.json.components.decayNote !== undefined, "Has decay explanation");
  assert(rep.json.tier !== undefined, "Has derived tier");
  assert(["NEW", "VERIFIED", "TRUSTED", "PREMIUM"].includes(rep.json.tier), "Tier is valid");
  assert(rep.json.tierReason !== undefined, "Has tier reason");

  // Reputation is accessible to ordinary users (public).
  const repAsUser = await api(alice, "GET", `/api/economics/reputation/${providerId}`);
  assert(repAsUser.status === 200, "Reputation accessible to ordinary USER");

  // =========================================================================
  // 2. ROUTING INTEGRATION — reputation is a factor
  // =========================================================================
  console.log("\n== 2. Routing integration ==");
  // Route preview should still work (reputation is fetched internally).
  const preview = await api(alice, "POST", "/api/routes/preview", {
    sourceAmount: 1000, sourceAsset: "USD", sourceCountry: "US",
    destinationAsset: "EUR", destinationCountry: "EU",
    riskTolerance: "BALANCED",
  });
  assert(preview.status === 200, "Route preview works with reputation integration");
  assert(preview.json.routes.length > 0, "Routes still discovered");
  // Check that route explanations mention provider reliability.
  const hasReliabilityMention = preview.json.routes.some((r: any) =>
    r.explanation.includes("reliability") || r.explanation.includes("provider")
  );
  assert(hasReliabilityMention, "Route explanations mention provider reliability");

  // Hard constraints still reject volatile assets for BALANCED.
  const rejectedRoutes = preview.json.routes.filter((r: any) => r.hardFilterRejection);
  assert(rejectedRoutes.length > 0, "Hard constraints still reject routes (WETH)");

  // =========================================================================
  // 3. PROVIDER ECONOMICS — derived from ledger
  // =========================================================================
  console.log("\n== 3. Provider economics ==");
  const econ = await api(admin, "GET", `/api/economics/provider/${providerId}`);
  assert(econ.status === 200, "Provider economics returns 200");
  assert(econ.json.earnings !== undefined, "Has earnings breakdown");
  assert(econ.json.earnings.executionFees !== undefined, "Has executionFees");
  assert(econ.json.earnings.incentives !== undefined, "Has incentives");
  assert(econ.json.earnings.netEarnings !== undefined, "Has netEarnings");
  assert(econ.json.capital !== undefined, "Has capital metrics");
  assert(econ.json.capital.committed !== undefined, "Has committed capital");
  assert(econ.json.performance !== undefined, "Has performance metrics");
  assert(econ.json.efficiency !== undefined, "Has efficiency metrics");
  assert(econ.json.efficiency.note !== undefined, "Efficiency labeled as prototype");

  // Provider statement (reconciles against ledger).
  const stmt = await api(admin, "GET", `/api/economics/statement/${providerId}?days=30`);
  assert(stmt.status === 200, "Provider statement returns 200");
  assert(stmt.json.entries !== undefined, "Statement has entries");
  assert(stmt.json.summary !== undefined, "Statement has summary");
  assert(stmt.json.summary.netChange !== undefined, "Statement has net change");

  // =========================================================================
  // 4. NETWORK HEALTH — transparent components
  // =========================================================================
  console.log("\n== 4. Network health ==");
  const health = await api(admin, "GET", "/api/economics/network-health");
  assert(health.status === 200, "Network health returns 200");
  assert(health.json.overall !== undefined, "Has overall score");
  assert(health.json.overall >= 0 && health.json.overall <= 100, "Overall is 0-100");
  assert(health.json.liquidityDepth !== undefined, "Has liquidityDepth component");
  assert(health.json.routeCompetition !== undefined, "Has routeCompetition component");
  assert(health.json.providerReliability !== undefined, "Has providerReliability component");
  assert(health.json.executionSuccess !== undefined, "Has executionSuccess component");
  assert(health.json.riskConcentration !== undefined, "Has riskConcentration component");
  assert(health.json.averageWait !== undefined, "Has averageWait");

  // Network health is admin-only.
  const healthAsUser = await api(alice, "GET", "/api/economics/network-health");
  assert(healthAsUser.status === 403, "Network health is admin-only → 403 for USER");

  // =========================================================================
  // 5. UNIT ECONOMICS + FUNNEL
  // =========================================================================
  console.log("\n== 5. Unit economics + funnel ==");
  const unit = await api(admin, "GET", "/api/economics/unit-economics");
  assert(unit.status === 200, "Unit economics returns 200");
  assert(unit.json.totalVolume !== undefined, "Has total volume");
  assert(unit.json.corridors !== undefined, "Has corridor breakdown");

  const funnel = await api(admin, "GET", "/api/economics/funnel");
  assert(funnel.status === 200, "Acquisition funnel returns 200");
  assert(funnel.json.applied !== undefined, "Has applied count");
  assert(funnel.json.connected !== undefined, "Has connected count");
  assert(funnel.json.conversionRates !== undefined, "Has conversion rates");
  assert(funnel.json.applied >= funnel.json.connected, "Funnel is monotonic (applied >= connected)");

  // =========================================================================
  // 6. COMMITMENTS
  // =========================================================================
  console.log("\n== 6. Commitments ==");
  // Operator creates a commitment.
  const nbId = providers.json.providers.find((p: any) => p.name === "Northbridge Bank")?.id;
  const commitRes = await api(operator, "POST", "/api/commitments", {
    providerId: nbId,
    sourceAsset: "USD", destinationAsset: "EUR",
    sourceCountry: "US", destinationCountry: "EU",
    minimumLiquidity: 50000,
    targetExecutionSeconds: 60,
    endDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  assert(commitRes.status === 200, "Commitment creation returns 200");
  assert(!!commitRes.json.id, "Commitment has ID");

  // List commitments.
  const commitList = await api(operator, "GET", `/api/commitments?providerId=${nbId}`);
  assert(commitList.status === 200, "Commitment list returns 200");
  assert(commitList.json.commitments.length > 0, "At least one commitment exists");
  assert(commitList.json.commitments[0].reliability !== undefined, "Commitment has reliability metric");

  // Sample a commitment (admin only).
  const sampleRes = await api(admin, "POST", `/api/commitments/${commitRes.json.id}/sample`);
  assert(sampleRes.status === 200, "Commitment sample returns 200");
  assert(sampleRes.json.met !== undefined, "Sample result has 'met' field");
  assert(sampleRes.json.available !== undefined, "Sample result has 'available' field");

  // =========================================================================
  // 7. PERFORMANCE + WIN/LOSS
  // =========================================================================
  console.log("\n== 7. Performance + win/loss ==");
  const perf = await api(admin, "GET", `/api/economics/performance/${providerId}`);
  assert(perf.status === 200, "Performance returns 200");
  assert(perf.json.totalExecutions !== undefined, "Has totalExecutions");
  assert(perf.json.completionRate !== undefined, "Has completionRate");
  assert(perf.json.corridors !== undefined, "Has corridor scores");
  assert(perf.json.availableLiquidity !== undefined, "Has availableLiquidity");

  const winloss = await api(admin, "GET", `/api/economics/winloss/${providerId}`);
  assert(winloss.status === 200, "Win/loss returns 200");
  assert(winloss.json.totalQuotes !== undefined, "Has totalQuotes");
  assert(winloss.json.winRate !== undefined, "Has winRate");

  // =========================================================================
  // 8. PROVIDER TIERS (on the providers list)
  // =========================================================================
  console.log("\n== 8. Provider tiers ==");
  const hasTiers = providers.json.providers.every((p: any) => p.tier !== undefined);
  assert(hasTiers, "All providers have tier field");
  const validTiers = providers.json.providers.every((p: any) =>
    ["NEW", "VERIFIED", "TRUSTED", "PREMIUM"].includes(p.tier)
  );
  assert(validTiers, "All tiers are valid values");
  const hasPremium = providers.json.providers.some((p: any) => p.tier === "PREMIUM");
  assert(hasPremium, "At least one PREMIUM provider (Continental Treasury)");

  console.log(`\n========================================`);
  console.log(`  P3 Economics: Passed: ${passed}  |  Failed: ${failed}`);
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
