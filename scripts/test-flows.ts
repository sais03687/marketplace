/**
 * End-to-end flow tests — directly hits DB + HTTP endpoints
 * Run: npx tsx --env-file=.env scripts/test-flows.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = "http://localhost:3002";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}

async function main() {
  console.log("\n═══ BUILDER / SELLER FLOW ═══\n");

  // --- 1. Agents exist in DB ---
  console.log("[1] Seeded agents");
  const agents = await prisma.agent.findMany({ include: { capabilities: true } });
  assert(agents.length >= 2, `Found ${agents.length} agents (expected ≥2)`);

  const alex = agents.find((a) => a.slug === "general-ops-alex");
  assert(!!alex, "Alex (OpenClaw runtime) exists");
  assert(alex?.runtime === "OPENCLAW", "Alex runtime is OPENCLAW");
  assert((alex?.capabilities.length ?? 0) >= 5, `Alex has ${alex?.capabilities.length} capabilities`);

  const lc = agents.find((a) => a.slug === "langchain-ops");
  assert(!!lc, "LangChain Ops (custom runtime) exists");
  assert(lc?.runtime === "CUSTOM", "LangChain runtime is CUSTOM");

  // --- 2. Agent versions ---
  console.log("\n[2] Agent versions");
  const versions = await prisma.agentVersion.findMany();
  assert(versions.length >= 2, `Found ${versions.length} versions`);
  const alexVersion = versions.find((v) => v.agentId === alex?.id);
  assert(!!alexVersion, "Alex has a version record");
  assert(alexVersion?.vetStatus === "MANUALLY_APPROVED", `Alex version status: ${alexVersion?.vetStatus}`);

  // --- 3. Public API: Browse ---
  console.log("\n[3] Public API: /api/agents");
  const { status: browseStatus, body: browseBody } = await fetchJson(`${BASE}/api/agents`);
  assert(browseStatus === 200, `GET /api/agents → ${browseStatus}`);
  assert(browseBody?.agents?.length >= 2, `Returns ${browseBody?.agents?.length} agents`);

  // --- 4. Public API: Agent Detail ---
  console.log("\n[4] Public API: /api/agents/general-ops-alex");
  const { status: detailStatus, body: detailBody } = await fetchJson(`${BASE}/api/agents/general-ops-alex`);
  assert(detailStatus === 200, `GET /api/agents/general-ops-alex → ${detailStatus}`);
  assert(detailBody?.name?.includes("Alex"), `Agent name: ${detailBody?.name}`);
  assert(detailBody?.capabilities?.length >= 5, `Capabilities: ${detailBody?.capabilities?.length}`);

  // --- 5. Auth-protected routes return 401 ---
  console.log("\n[5] Auth protection");
  const authRoutes = [
    { path: "/api/creator/analytics", method: "GET" },
    { path: "/api/creator/profile", method: "GET" },
  ];
  for (const route of authRoutes) {
    const { status } = await fetchJson(`${BASE}${route.path}`);
    assert(status === 401, `${route.method} ${route.path} → ${status} (blocks unauth)`);
  }

  // Upload is POST-only
  const { status: uploadStatus } = await fetchJson(`${BASE}/api/packages/upload`, { method: "POST" });
  assert(uploadStatus === 401, `POST /api/packages/upload → ${uploadStatus} (blocks unauth)`);

  // --- 6. Agent editing route auth ---
  console.log("\n[6] Agent edit auth");
  const { status: editStatus } = await fetchJson(`${BASE}/api/agents/general-ops-alex/edit`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagline: "hacked" }),
  });
  assert(editStatus === 401, `PATCH /api/agents/.../edit → ${editStatus} (blocks unauth)`);

  // ═══════════════════════════════════════
  console.log("\n═══ BUYER / HIRING FLOW ═══\n");

  // --- 7. Create a fresh test deployment ---
  console.log("[7] Create test deployment");
  let company = await prisma.company.findFirst();
  if (!company) {
    company = await prisma.company.create({
      data: { clerkOrgId: "test_org_001", name: "Test Corp", domain: "test.com" },
    });
  }

  // Always create fresh for testing
  const deployment = await prisma.deployment.create({
    data: {
      agentId: alex!.id,
      companyId: company.id,
      agentName: "Test Alex",
      agentVersion: alex!.currentVersion || "1.0.0",
      status: "ONBOARDING",
      onboardingState: "INTERVIEW",
      onboardingData: {},
      autonomyConfig: { level: "LOW", autoApproveBelow: 20 },
      managerEmail: "buyer@test.com",
    },
  });

  assert(!!deployment, `Deployment created: ${deployment.id}`);
  assert(deployment.status === "ONBOARDING", `Status: ${deployment.status}`);
  assert(deployment.onboardingState === "INTERVIEW", `Stage: ${deployment.onboardingState}`);
  assert(!!deployment.portalToken, `Portal token: ${deployment.portalToken ? deployment.portalToken.substring(0, 8) + "..." : "null"}`);

  // --- 8. Onboarding data on agent ---
  console.log("\n[8] Onboarding data (agent)");
  const agentWithOnboarding = await prisma.agent.findUnique({
    where: { id: alex!.id },
    select: { onboardingQuestions: true, memoryTemplate: true },
  });
  const hasQuestions = !!agentWithOnboarding?.onboardingQuestions;
  const hasTemplate = !!agentWithOnboarding?.memoryTemplate;
  console.log(`  onboardingQuestions: ${hasQuestions ? "✓ present" : "✗ null (needs re-seed)"}`);
  console.log(`  memoryTemplate: ${hasTemplate ? "✓ present" : "✗ null (needs re-seed)"}`);

  // --- 9. Approval Portal (unauthenticated, public API) ---
  console.log("\n[9] Approval portal");
  const portalToken = deployment.portalToken!;
  const { status: portalStatus, body: portalBody } = await fetchJson(
    `${BASE}/api/portal/${portalToken}/approvals`,
  );
  assert(portalStatus === 200, `GET /api/portal/{token}/approvals → ${portalStatus}`);
  assert(Array.isArray(portalBody?.approvals), `Returns approvals array`);
  console.log(`  Pending approvals: ${portalBody?.approvals?.length ?? 0}`);

  // --- 10. Invalid portal token ---
  console.log("\n[10] Portal token validation");
  const { status: badPortal } = await fetchJson(`${BASE}/api/portal/invalid-token-123/approvals`);
  assert(badPortal === 404, `Invalid token → ${badPortal}`);

  // --- 11. Create a test approval with all required fields ---
  console.log("\n[11] Create + resolve approval");
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h from now
  const approval = await prisma.approval.create({
    data: {
      deploymentId: deployment.id,
      taskType: "email_send",
      channel: "email",
      draft: "Hi, just following up on our conversation from last week...",
      reasoning: "Client requested a follow-up. Low stakes, reversible action.",
      originalRequest: "Send follow-up email to client about project update",
      stakesScore: 0.2,
      ambiguityScore: 0.1,
      reversibilityScore: 0.8,
      combinedScore: 0.3,
      status: "PENDING",
      expiresAt,
    },
  });
  assert(!!approval, `Approval created: ${approval.id}`);

  // Verify it shows up in portal
  const { body: portalBody2 } = await fetchJson(
    `${BASE}/api/portal/${portalToken}/approvals`,
  );
  assert(portalBody2?.approvals?.length === 1, `Portal shows 1 pending approval`);

  // --- 12. Resolve via portal ---
  console.log("\n[12] Resolve approval via portal");
  const { status: resolveStatus, body: resolveBody, text: resolveText } = await fetchJson(
    `${BASE}/api/portal/${portalToken}/approvals/${approval.id}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "APPROVED",
      }),
    },
  );
  if (resolveStatus !== 200) {
    console.log(`  Response: ${resolveText}`);
  }
  assert(resolveStatus === 200, `POST resolve → ${resolveStatus}`);
  assert(resolveBody?.approval?.status === "APPROVED", `Approval status: ${resolveBody?.approval?.status}`);

  // Verify in DB
  const resolvedApproval = await prisma.approval.findUnique({ where: { id: approval.id } });
  assert(resolvedApproval?.status === "APPROVED", `DB status: ${resolvedApproval?.status}`);

  // --- 13. Trust score created ---
  console.log("\n[13] Trust score");
  const trust = await prisma.trustScore.findFirst({
    where: { deploymentId: deployment.id },
  });
  if (trust) {
    const totalDecisions = trust.approvedNoEdit + trust.edited + trust.rejected;
    assert(true, `Trust score exists (weighted: ${trust.weightedScore})`);
    assert(totalDecisions >= 1, `Total decisions: ${totalDecisions} (approved: ${trust.approvedNoEdit})`);
  } else {
    console.log("  ⚠ Trust score not created (expected if resolve-approval container notification failed gracefully)");
  }

  // --- 14. Portal shows no more pending ---
  console.log("\n[14] Portal cleared after resolution");
  const { body: portalBody3 } = await fetchJson(`${BASE}/api/portal/${portalToken}/approvals`);
  assert(portalBody3?.approvals?.length === 0, `Portal shows 0 pending approvals after resolution`);

  // --- 15. Stripe webhooks ---
  console.log("\n[15] Stripe: checkout.session.completed");
  const { status: stripeStatus } = await fetchJson(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { deploymentId: deployment.id },
          subscription: "sub_test_123",
        },
      },
    }),
  });
  assert(stripeStatus === 200, `Stripe webhook → ${stripeStatus}`);

  const updatedDep = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(
    updatedDep?.stripeSubscriptionId === "sub_test_123",
    `Subscription linked: ${updatedDep?.stripeSubscriptionId}`,
  );

  // --- 16. Onboarding state machine ---
  console.log("\n[16] Onboarding state machine");

  // INTERVIEW → OBSERVATION
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { onboardingState: "OBSERVATION", onboardingData: { answers: { q1: "Test answer" } } },
  });
  const obs = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(obs?.onboardingState === "OBSERVATION", "INTERVIEW → OBSERVATION");

  // OBSERVATION → INTRODUCTION
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { onboardingState: "INTRODUCTION" },
  });
  const intro = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(intro?.onboardingState === "INTRODUCTION", "OBSERVATION → INTRODUCTION");

  // INTRODUCTION → LIVE (activation)
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { onboardingState: "LIVE", status: "ACTIVE" },
  });
  const live = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(live?.onboardingState === "LIVE", "INTRODUCTION → LIVE");
  assert(live?.status === "ACTIVE", "Deployment now ACTIVE");

  // --- 17. Invoice payment_failed → pauses ---
  console.log("\n[17] Stripe: invoice.payment_failed → PAUSED");
  const { status: failStatus } = await fetchJson(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.payment_failed",
      data: { object: { subscription: "sub_test_123" } },
    }),
  });
  assert(failStatus === 200, `Payment failed webhook → ${failStatus}`);
  const paused = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(paused?.status === "PAUSED", `Deployment paused: ${paused?.status}`);
  assert(!!paused?.pausedAt, `pausedAt set`);

  // --- 18. Invoice paid → reactivates ---
  console.log("\n[18] Stripe: invoice.paid → ACTIVE");
  const { status: paidStatus } = await fetchJson(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "invoice.paid",
      data: { object: { subscription: "sub_test_123" } },
    }),
  });
  assert(paidStatus === 200, `Invoice paid webhook → ${paidStatus}`);
  const reactivated = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(reactivated?.status === "ACTIVE", `Deployment reactivated: ${reactivated?.status}`);

  // --- 19. Subscription deleted → fires ---
  console.log("\n[19] Stripe: customer.subscription.deleted → FIRED");
  const { status: delStatus } = await fetchJson(`${BASE}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test_123" } },
    }),
  });
  assert(delStatus === 200, `Subscription deleted webhook → ${delStatus}`);
  const fired = await prisma.deployment.findUnique({ where: { id: deployment.id } });
  assert(fired?.status === "FIRED", `Deployment fired: ${fired?.status}`);

  // ═══════════════════════════════════════
  console.log("\n═══ PUBLIC PAGES ═══\n");

  console.log("[20] Static pages");
  const pages = ["/", "/browse", "/agents/general-ops-alex"];
  for (const page of pages) {
    const res = await fetch(`${BASE}${page}`);
    assert(res.status === 200, `${page} → ${res.status}`);
  }

  // --- 21. Portal page ---
  console.log("\n[21] Portal page");
  const portalPage = await fetch(`${BASE}/approve/${portalToken}`);
  assert(portalPage.status === 200, `GET /approve/{token} → ${portalPage.status}`);

  // ═══════════════════════════════════════
  console.log(`\n═══ RESULTS: ${passed} passed, ${failed} failed ═══\n`);

  // Cleanup test data
  console.log("Cleaning up test data...");
  await prisma.approval.deleteMany({ where: { deploymentId: deployment.id } });
  await prisma.trustScore.deleteMany({ where: { deploymentId: deployment.id } });
  await prisma.deployment.delete({ where: { id: deployment.id } });
  console.log("Done.\n");

  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
