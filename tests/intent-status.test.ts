/**
 * dRamp intent status consistency — regression test.
 *
 * Proves that GET /api/intents/[id] returns a intent.status that is consistent
 * with the execution.status after on-demand advancement. Before the fix, the
 * route fetched the intent BEFORE calling advanceOneOnDemand, then serialized
 * the stale intent — so a completed execution would still show
 * intent.status="ACTIVE".
 *
 * This test:
 *   1. Logs in as Alice.
 *   2. Creates a NOW intent (immediate execution).
 *   3. Polls GET /api/intents/[id] until the execution reaches COMPLETED.
 *   4. Asserts that intent.status === "COMPLETED" in the SAME response where
 *      execution.status === "COMPLETED" (no stale serialization).
 *
 * Requires a running, seeded server (default http://localhost:3000).
 *
 * Usage: bun tests/intent-status.test.ts
 */

const BASE = process.env.DRAMP_URL ?? "http://localhost:3000";
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 120_000;

interface CookieJar {
  cookie: string;
  csrfToken: string;
}

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
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ ${label}`);
  }
}

async function main() {
  console.log(`dRamp intent-status consistency test → ${BASE}`);

  const seed = await fetch(`${BASE}/api/seed`).then((r) => r.json() as any);
  if (!seed.seeded) {
    console.error("Marketplace not seeded. Run POST /api/seed first.");
    process.exit(1);
  }

  console.log("\n== Login as Alice ==");
  const alice = await login("alice@dramp.demo", "Demo1234!");
  console.log("  OK");

  console.log("\n== Create a NOW intent ==");
  const intent = await api(alice, "POST", "/api/intents", {
    sourceAmount: 500,
    sourceAsset: "USD",
    sourceCountry: "US",
    destinationAsset: "EUR",
    destinationCountry: "EU",
    riskTolerance: "BALANCED",
    executionPolicy: "NOW",
    maxWaitSeconds: 60,
  });
  if (!intent.json.intentId) {
    console.error("Failed to create intent:", intent.json);
    process.exit(1);
  }
  const intentId = intent.json.intentId;
  const executionId = intent.json.executionId;
  console.log(`  intentId=${intentId}, executionId=${executionId}`);

  console.log("\n== Polling until COMPLETED (checking intent/exec status consistency) ==");

  let sawCompleted = false;
  let sawStaleIntent = false;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const res = await api(alice, "GET", `/api/intents/${intentId}`);
    if (res.status !== 200) {
      console.error(`  unexpected status ${res.status}`);
      break;
    }
    const execStatus = res.json.execution?.status;
    const intentStatus = res.json.intent?.status;

    console.log(`  exec=${execStatus} intent=${intentStatus}`);

    // The core assertion: whenever the execution is COMPLETED, the intent
    // must ALSO be COMPLETED in the same response (no stale serialization).
    if (execStatus === "COMPLETED") {
      sawCompleted = true;
      if (intentStatus !== "COMPLETED") {
        sawStaleIntent = true;
        console.error(`  STALE: exec=COMPLETED but intent=${intentStatus}`);
      }
      break;
    }

    // While the execution is in-flight, the intent should still be ACTIVE.
    // (It only transitions to COMPLETED when completeExecution runs.)
    if (execStatus && execStatus !== "COMPLETED" && !["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"].includes(execStatus)) {
      assert(
        intentStatus === "ACTIVE",
        `intent.status=ACTIVE while exec.status=${execStatus} (in-flight)`,
      );
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  assert(sawCompleted, "execution reached COMPLETED within timeout");
  assert(!sawStaleIntent, "intent.status is COMPLETED in the same response as execution.status=COMPLETED (no stale serialization)");

  // ---- Also verify via GET /api/executions/[id] (already correct) ----
  console.log("\n== Cross-check via GET /api/executions/[id] ==");
  const execRes = await api(alice, "GET", `/api/executions/${executionId}`);
  if (execRes.status === 200) {
    const eStatus = execRes.json.execution?.status;
    const iStatus = execRes.json.execution?.intent?.status;
    console.log(`  exec=${eStatus} intent(via exec)=${iStatus}`);
    if (eStatus === "COMPLETED") {
      assert(
        iStatus === "COMPLETED",
        "GET /api/executions/[id] intent.status consistent with execution.status",
      );
    }
  }

  console.log(`\n========================================`);
  console.log(`  Intent status consistency: Passed: ${passed}  |  Failed: ${failed}`);
  console.log(`========================================`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export {};
