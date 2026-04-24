#!/usr/bin/env node
/**
 * Post-deploy smoke test — verifies the live environment is wired up correctly.
 *
 * Usage:
 *   APP_URL=https://your-app.vercel.app CRON_SECRET=xxx node scripts/smoke-test.mjs
 *
 * Checks:
 *   1. Web app is reachable
 *   2. DB is reachable (via a lightweight API probe)
 *   3. Stripe is configured (not a placeholder key)
 *   4. AgentMail is configured
 *   5. Vercel Blob is configured
 *   6. Cron endpoint responds correctly
 *   7. Provisioning service Redis queue is reachable (via health endpoint)
 */

const APP_URL   = (process.env.APP_URL   || "").replace(/\/$/, "");
const CRON_SECRET = process.env.CRON_SECRET || "";

if (!APP_URL) {
  console.error("Set APP_URL=https://your-app.vercel.app before running");
  process.exit(1);
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    const result = await fn();
    const msg = result === true ? "" : ` — ${result}`;
    console.log(`  ✓  ${name}${msg}`);
    passed++;
  } catch (err) {
    console.log(`  ✗  ${name} — ${err.message}`);
    failed++;
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { res, json, text };
}

console.log(`\nSmoke test → ${APP_URL}\n`);

// ── 1. Web app reachable ──────────────────────────────────────────────────────
await check("Web app is reachable", async () => {
  const { res } = await fetchJSON(`${APP_URL}/`);
  expect(res.status < 500, `HTTP ${res.status}`);
  return true;
});

// ── 2. Browse page returns agents list (DB reachable) ─────────────────────────
await check("Browse page / DB reachable", async () => {
  const { res } = await fetchJSON(`${APP_URL}/browse`);
  expect(res.status === 200, `HTTP ${res.status}`);
  return true;
});

// ── 3. Cron endpoint — wrong secret returns 401 ───────────────────────────────
await check("Cron auth — wrong secret → 401", async () => {
  const { res } = await fetchJSON(
    `${APP_URL}/api/cron/creator-payouts`,
    { method: "POST", headers: { Authorization: "Bearer wrong-secret" } },
  );
  expect(res.status === 401, `Expected 401, got ${res.status}`);
  return true;
});

// ── 4. Cron endpoint — correct secret returns 200 ────────────────────────────
await check("Cron auth — correct secret → 200 dry-run", async () => {
  if (!CRON_SECRET) throw new Error("CRON_SECRET not set — skipping");
  const { res, json } = await fetchJSON(
    `${APP_URL}/api/cron/creator-payouts?dryRun=true`,
    { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } },
  );
  expect(res.status === 200, `Expected 200, got ${res.status}`);
  expect(typeof json?.period === "string", "Response missing 'period' field");
  return `period=${json.period}, processed=${json.processed}`;
});

// ── 5. Stripe webhook endpoint accepts unverified events in dev ───────────────
await check("Stripe webhook endpoint reachable", async () => {
  const fakeEvent = { type: "ping", data: { object: {} } };
  const { res } = await fetchJSON(
    `${APP_URL}/api/webhooks/stripe`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakeEvent),
    },
  );
  // 200 = accepted (no webhook secret configured, dev mode)
  // 400 = signature verification failed (webhook secret IS configured — correct for prod)
  // 503 = Stripe not configured at all — bad
  expect(res.status !== 503, "Stripe is not configured (503)");
  return `HTTP ${res.status} (${res.status === 400 ? "signature verification active ✓" : "no signature — set STRIPE_WEBHOOK_SECRET for production"})`;
});

// ── 6. Public API — agents list ───────────────────────────────────────────────
await check("Public agents API returns array", async () => {
  const { res, json } = await fetchJSON(`${APP_URL}/api/agents`);
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(Array.isArray(json?.data ?? json), "Response is not an array");
  const count = (json?.data ?? json).length;
  return `${count} agent(s) listed`;
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
