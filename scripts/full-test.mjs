#!/usr/bin/env node
/**
 * Full platform test suite.
 *
 * Usage:
 *   APP_URL=https://... CRON_SECRET=xxx node scripts/full-test.mjs
 */

const APP_URL     = (process.env.APP_URL || "").replace(/\/$/, "");
const CRON_SECRET = process.env.CRON_SECRET || "";

if (!APP_URL) { console.error("Set APP_URL before running"); process.exit(1); }

let passed = 0;
let failed = 0;
let skipped = 0;

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === "SKIP") { console.log(`  -  ${name} — skipped`); skipped++; return; }
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
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(12_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { res, json, text };
}

// ── SECTION 1: Public pages ───────────────────────────────────────────────────
console.log(`\nFull test suite → ${APP_URL}\n`);
console.log("── 1. Public pages ──────────────────────────────────────────────");

await check("Home page loads", async () => {
  const { res } = await fetchJSON(`${APP_URL}/`);
  expect(res.status < 500, `HTTP ${res.status}`);
  return true;
});

await check("Browse page loads", async () => {
  const { res } = await fetchJSON(`${APP_URL}/browse`);
  expect(res.status === 200, `HTTP ${res.status}`);
  return true;
});

await check("Sign-in page loads", async () => {
  const { res } = await fetchJSON(`${APP_URL}/sign-in`);
  expect(res.status < 500, `HTTP ${res.status}`);
  return true;
});

await check("Sign-up page loads", async () => {
  const { res } = await fetchJSON(`${APP_URL}/sign-up`);
  expect(res.status < 500, `HTTP ${res.status}`);
  return true;
});

// ── SECTION 2: Public API ─────────────────────────────────────────────────────
console.log("\n── 2. Public API ────────────────────────────────────────────────");

await check("GET /api/agents — returns array", async () => {
  const { res, json } = await fetchJSON(`${APP_URL}/api/agents`);
  expect(res.status === 200, `HTTP ${res.status}`);
  const agents = json?.agents ?? json?.data ?? json;
  expect(Array.isArray(agents), "Not an array");
  return `${agents.length} agent(s)`;
});

await check("GET /api/agents — sort by price works", async () => {
  const { res, json } = await fetchJSON(`${APP_URL}/api/agents?sort=price`);
  expect(res.status === 200, `HTTP ${res.status}`);
  const agents = json?.agents ?? json?.data ?? json;
  expect(Array.isArray(agents), "Not an array");
  return `${agents.length} agent(s)`;
});

await check("GET /api/agents — search query works", async () => {
  const { res, json } = await fetchJSON(`${APP_URL}/api/agents?q=alex`);
  expect(res.status === 200, `HTTP ${res.status}`);
  const agents = json?.agents ?? json?.data ?? json;
  expect(Array.isArray(agents), "Not an array");
  return `${agents.length} result(s) for 'alex'`;
});

await check("GET /api/agents/[slug] — valid slug returns 200", async () => {
  // First get a real slug from the list
  const { json: listJson } = await fetchJSON(`${APP_URL}/api/agents`);
  const agents = listJson?.agents ?? listJson?.data ?? listJson;
  if (!agents?.length) return "SKIP";
  const slug = agents[0].slug;
  const { res, json } = await fetchJSON(`${APP_URL}/api/agents/${slug}`);
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(json?.slug === slug || json?.agent?.slug === slug, "Slug mismatch");
  return `slug=${slug}`;
});

await check("GET /api/agents/nonexistent — returns 404", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/agents/does-not-exist-xyz`);
  expect(res.status === 404, `Expected 404, got ${res.status}`);
  return true;
});

// ── SECTION 3: Auth protection ────────────────────────────────────────────────
console.log("\n── 3. Auth protection ───────────────────────────────────────────");

await check("GET /dashboard — redirects to sign-in (not 500)", async () => {
  const { res } = await fetchJSON(`${APP_URL}/dashboard`);
  expect(res.status !== 500, `HTTP ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /creator — redirects to sign-in (not 500)", async () => {
  const { res } = await fetchJSON(`${APP_URL}/creator`);
  expect(res.status !== 500, `HTTP ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /api/deployments — returns 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/deployments`);
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /api/creator/analytics — returns 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/creator/analytics`);
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /api/creator/payouts — returns 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/creator/payouts`);
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /api/agentmind/stats — returns 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/agentmind/stats`);
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /admin/vetting — not publicly accessible (not 200)", async () => {
  const { res } = await fetchJSON(`${APP_URL}/admin/vetting`);
  expect(res.status !== 200, `Expected redirect/auth, got 200`);
  return `HTTP ${res.status}`;
});

// ── SECTION 4: Webhooks ───────────────────────────────────────────────────────
console.log("\n── 4. Webhooks ──────────────────────────────────────────────────");

await check("POST /api/webhooks/stripe — reachable (not 503)", async () => {
  const { res, json, text } = await fetchJSON(`${APP_URL}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "ping", data: { object: {} } }),
  });
  expect(res.status !== 503, "Stripe not configured (503)");
  return `HTTP ${res.status}`;
});

await check("POST /api/webhooks/approvals/fake — returns 404 or 401", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/webhooks/approvals/fake-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status === 404 || res.status === 401 || res.status === 400, `Unexpected ${res.status}`);
  return `HTTP ${res.status}`;
});

// ── SECTION 5: Cron jobs ──────────────────────────────────────────────────────
console.log("\n── 5. Cron jobs ─────────────────────────────────────────────────");

await check("Cron — wrong secret → 401", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/cron/creator-payouts`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-secret" },
  });
  expect(res.status === 401, `Expected 401, got ${res.status}`);
  return true;
});

await check("Cron — creator-payouts dry-run → 200, no failures", async () => {
  if (!CRON_SECRET) return "SKIP";
  const { res, json } = await fetchJSON(`${APP_URL}/api/cron/creator-payouts?dryRun=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(json?.failed === 0, `failed=${json?.failed} — Payout table or logic error`);
  return `period=${json.period}, processed=${json.processed}, skipped=${json.skipped}`;
});

await check("Cron — expire-approvals → 200", async () => {
  if (!CRON_SECRET) return "SKIP";
  const { res, json } = await fetchJSON(`${APP_URL}/api/cron/expire-approvals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(typeof json?.expired === "number", "Missing 'expired' field");
  return `expired=${json.expired}`;
});

await check("Cron — update-trust-scores → 200", async () => {
  if (!CRON_SECRET) return "SKIP";
  const { res, json } = await fetchJSON(`${APP_URL}/api/cron/update-trust-scores`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(res.status === 200, `HTTP ${res.status}`);
  expect(typeof json?.updated === "number", "Missing 'updated' field");
  return `updated=${json.updated}`;
});

// ── SECTION 6: AgentMind (public-facing) ──────────────────────────────────────
console.log("\n── 6. AgentMind ─────────────────────────────────────────────────");

await check("GET /api/agentmind/contributions — 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/agentmind/contributions`);
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("POST /api/agentmind/vote — 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/agentmind/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contributionId: "fake", vote: 1 }),
  });
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("POST /api/agentmind/contribute — 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/agentmind/contribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "PATTERN", content: "test", tags: [] }),
  });
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

// ── SECTION 7: Approval portal ────────────────────────────────────────────────
console.log("\n── 7. Approval portal ───────────────────────────────────────────");

await check("GET /approve/fake-token — returns 404 or redirect (not 500)", async () => {
  const { res } = await fetchJSON(`${APP_URL}/approve/fake-token-xyz`);
  expect(res.status !== 500, `HTTP ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("GET /api/portal/fake-token/approvals — returns 404 or 401", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/portal/fake-token-xyz/approvals`);
  expect(res.status === 404 || res.status === 401 || res.status === 403, `Unexpected ${res.status}`);
  return `HTTP ${res.status}`;
});

// ── SECTION 8: Packages upload ────────────────────────────────────────────────
console.log("\n── 8. Package upload ────────────────────────────────────────────");

await check("POST /api/packages/upload — 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/packages/upload`, {
    method: "POST",
  });
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

// ── SECTION 9: Billing ────────────────────────────────────────────────────────
console.log("\n── 9. Billing ───────────────────────────────────────────────────");

await check("GET /api/company/billing — 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/company/billing`);
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

await check("POST /api/company/billing/cancel — 401 without auth", async () => {
  const { res } = await fetchJSON(`${APP_URL}/api/company/billing/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscriptionId: "fake" }),
  });
  expect(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  return `HTTP ${res.status}`;
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
if (failed > 0) process.exit(1);
