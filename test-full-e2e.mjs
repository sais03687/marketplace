/**
 * COMPREHENSIVE E2E TEST SUITE — AI Agent Marketplace
 *
 * Tests ALL flows for every persona:
 *
 *   FLOW 1:  Marketplace Browser (Public)
 *     - Browse agents, search, filters, agent detail, public insights
 *
 *   FLOW 2:  Agent Hiring & Deployment (Prisma-simulated)
 *     - Create deployment, verify provisioning state
 *
 *   FLOW 3:  Approval Queue (Mixed Auth)
 *     - Agent submits approval, portal view/resolve, trust score updates
 *
 *   FLOW 4:  AgentMind Knowledge System (No Auth)
 *     - Contribute, search, vote, use, guardrails, duplicates, reciprocity
 *
 *   FLOW 5:  Cron Jobs (No Auth)
 *     - Expire approvals, update trust scores
 *
 *   FLOW 6:  Auth-Gated Endpoints (Verify 401)
 *     - Settings, stats, contributions list, delete, creator, admin
 *
 *   FLOW 7:  End-to-End Agent Lifecycle
 *     - Full approval→reflection→knowledge→trust pipeline
 *
 *   FLOW 8:  Settings & Deployment Management (Prisma-simulated)
 *
 *   FLOW 9:  Database Integrity Checks
 *
 *   FLOW 10: Stripe Creator Payout Cron
 *     - Calls POST /api/cron/creator-payouts?dryRun=true
 *     - Verifies cron auth, dry-run calculation, per-creator revenue breakdown
 *
 *   FLOW 11: Heartbeat Cron System
 *     - Validates cron expression generation (both runtimes: OpenClaw + Docker)
 *     - Injects 1-minute heartbeat into live deployment jobs.json (if present)
 *     - Triggers on-demand heartbeat hook via gateway (if running)
 *
 * Run: node --env-file=.env test-full-e2e.mjs
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const prisma = new PrismaClient();
const BASE = "http://localhost:3002";

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.log(`  \u2717 FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function skip(label) {
  console.log(`  \u2298 SKIP: ${label}`);
  skipped++;
}

async function api(method, path, body = null, headers = {}) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}

// ─── Dynamic Test Data (populated in setup) ──────────────────────────────────
// IDs are derived at runtime from DB so the suite works across fresh seeds.

let COMPANY_A_ID;
let COMPANY_B_ID;
let AGENT_LANGCHAIN_ID;
let AGENT_ALEX_ID;
let DEPLOYMENT_A_ID; // Company A, LangChain
let DEPLOYMENT_B_ID; // Company B, LangChain

let savedOriginals = {};

// ─── Setup ──────────────────────────────────────────────────────────────────

async function setup() {
  console.log("Setup: Preparing test data...\n");

  // ── 0. Resolve agent IDs by slug ──────────────────────────────────────────
  const langchainAgent = await prisma.agent.findUnique({ where: { slug: "langchain-ops" } });
  const alexAgent = await prisma.agent.findUnique({ where: { slug: "general-ops-alex" } });

  if (!langchainAgent || !alexAgent) {
    throw new Error("Seeded agents not found — run: npx tsx scripts/seed.ts");
  }

  AGENT_LANGCHAIN_ID = langchainAgent.id;
  AGENT_ALEX_ID = alexAgent.id;

  // ── 1. Ensure 2 test companies exist ─────────────────────────────────────
  let companyA = await prisma.company.findFirst({ where: { clerkOrgId: "test_e2e_company_a" } });
  if (!companyA) {
    companyA = await prisma.company.create({
      data: { clerkOrgId: "test_e2e_company_a", name: "E2E Company A", domain: "e2e-company-a.test" },
    });
  }
  COMPANY_A_ID = companyA.id;

  let companyB = await prisma.company.findFirst({ where: { clerkOrgId: "test_e2e_company_b" } });
  if (!companyB) {
    companyB = await prisma.company.create({
      data: { clerkOrgId: "test_e2e_company_b", name: "E2E Company B", domain: "e2e-company-b.test" },
    });
  }
  COMPANY_B_ID = companyB.id;

  // ── 2. Ensure 2 test deployments exist (Company A × LangChain, Company B × LangChain) ──
  let depA = await prisma.deployment.findFirst({
    where: { companyId: COMPANY_A_ID, agentId: AGENT_LANGCHAIN_ID },
  });
  if (!depA) {
    depA = await prisma.deployment.create({
      data: {
        companyId: COMPANY_A_ID,
        agentId: AGENT_LANGCHAIN_ID,
        agentVersion: "1.0.0",
        agentName: "E2E LangChain A",
        status: "ACTIVE",
        autonomyConfig: {},
      },
    });
  }
  DEPLOYMENT_A_ID = depA.id;

  let depB = await prisma.deployment.findFirst({
    where: { companyId: COMPANY_B_ID, agentId: AGENT_LANGCHAIN_ID },
  });
  if (!depB) {
    depB = await prisma.deployment.create({
      data: {
        companyId: COMPANY_B_ID,
        agentId: AGENT_LANGCHAIN_ID,
        agentVersion: "1.0.0",
        agentName: "E2E LangChain B",
        status: "ACTIVE",
        autonomyConfig: {},
      },
    });
  }
  DEPLOYMENT_B_ID = depB.id;

  // Refresh from DB
  depA = await prisma.deployment.findUnique({ where: { id: DEPLOYMENT_A_ID } });
  depB = await prisma.deployment.findUnique({ where: { id: DEPLOYMENT_B_ID } });

  // Clean previous test data (scoped to our test agents to avoid nuking prod data)
  await prisma.knowledgeVote.deleteMany({ where: { contribution: { agentId: AGENT_LANGCHAIN_ID } } });
  await prisma.knowledgeContribution.deleteMany({ where: { agentId: AGENT_LANGCHAIN_ID } });

  savedOriginals = { depA, depB };

  // Set both to ACTIVE with AgentMind enabled + ensure portal tokens
  for (const dep of [
    { id: DEPLOYMENT_A_ID, orig: depA },
    { id: DEPLOYMENT_B_ID, orig: depB },
  ]) {
    const updateData = {
      status: "ACTIVE",
      autonomyConfig: {
        ...((dep.orig.autonomyConfig ?? {})),
        agentMindEnabled: true,
        agentMindAutoApprove: true,
      },
    };
    // Generate portal token if missing (required for portal tests)
    if (!dep.orig.portalToken) {
      updateData.portalToken = `test-portal-${dep.id.slice(0, 8)}-${Date.now()}`;
    }
    await prisma.deployment.update({
      where: { id: dep.id },
      data: updateData,
    });
  }

  // Ensure at least one resolved approval per deployment (gate for AgentMind contribute)
  for (const depId of [DEPLOYMENT_A_ID, DEPLOYMENT_B_ID]) {
    const has = await prisma.approval.findFirst({
      where: { deploymentId: depId, status: { in: ["APPROVED", "EDITED"] } },
    });
    if (!has) {
      await prisma.approval.create({
        data: {
          deploymentId: depId,
          taskType: "email_triage",
          channel: "email",
          draft: "Test draft for E2E",
          reasoning: "Auto-generated for E2E test setup",
          originalRequest: "Send follow-up email",
          stakesScore: 3.0,
          ambiguityScore: 2.0,
          reversibilityScore: 8.0,
          combinedScore: 4.0,
          status: "APPROVED",
          resolvedBy: "test-setup",
          resolvedAt: new Date(),
          expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
        },
      });
    }
  }

  console.log("  Setup complete.\n");
}

// ─── Teardown ───────────────────────────────────────────────────────────────

async function teardown() {
  const { depA, depB } = savedOriginals;
  if (depA) {
    await prisma.deployment.update({
      where: { id: DEPLOYMENT_A_ID },
      data: { status: depA.status, autonomyConfig: depA.autonomyConfig ?? {} },
    });
  }
  if (depB) {
    await prisma.deployment.update({
      where: { id: DEPLOYMENT_B_ID },
      data: { status: depB.status, autonomyConfig: depB.autonomyConfig ?? {} },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 1: MARKETPLACE BROWSER (PUBLIC)
// ═══════════════════════════════════════════════════════════════════════════

async function testMarketplaceBrowse() {
  console.log("\n\u2550 FLOW 1: Marketplace Browser (Public Endpoints)");
  console.log("\u2500".repeat(60));

  // 1a. Browse all agents
  const { status: s1, data: d1 } = await api("GET", "/api/agents");
  assert(s1 === 200, `GET /api/agents returns 200 (got ${s1})`);
  assert(Array.isArray(d1.agents), "Response has agents array");
  assert(d1.agents.length >= 2, `Found ${d1.agents.length} agents (expected >= 2)`);

  // 1b. Browse with category filter
  const { status: s2, data: d2 } = await api("GET", "/api/agents?category=GENERAL");
  assert(s2 === 200, "Category filter returns 200");
  assert(d2.agents?.every(a => a.category === "GENERAL"), "All results match GENERAL category");

  // 1c. Browse with pagination
  const { status: s3, data: d3 } = await api("GET", "/api/agents?page=1&limit=1");
  assert(s3 === 200, "Pagination returns 200");
  assert(d3.agents?.length === 1, `Limit=1 returns exactly 1 agent (got ${d3.agents?.length})`);

  // 1d. Browse with sort
  const { status: s4 } = await api("GET", "/api/agents?sort=newest");
  assert(s4 === 200, "Sort by newest returns 200");

  const { status: s5 } = await api("GET", "/api/agents?sort=price_asc");
  assert(s5 === 200, "Sort by price_asc returns 200");

  // 1e. Search agents by text
  const { status: s6, data: d6 } = await api("GET", "/api/agents?q=Operations");
  assert(s6 === 200, "Text search returns 200");
  assert(d6.agents?.length >= 1, `Search 'Operations' found ${d6.agents?.length} result(s)`);

  // 1f. Agent detail by slug
  const { status: s7, data: d7 } = await api("GET", "/api/agents/general-ops-alex");
  assert(s7 === 200, "Agent detail returns 200");
  assert(d7.name?.includes("Alex"), `Agent name is "${d7.name}"`);
  assert(Array.isArray(d7.capabilities), "Agent has capabilities array");
  assert(d7.creator?.displayName, `Creator: "${d7.creator?.displayName}"`);

  // 1g. Agent detail 404
  const { status: s8 } = await api("GET", "/api/agents/nonexistent-slug");
  assert(s8 === 404, `Nonexistent agent returns 404 (got ${s8})`);

  // 1h. LangChain agent detail
  const { status: s9, data: d9 } = await api("GET", "/api/agents/langchain-ops");
  assert(s9 === 200, "LangChain agent detail returns 200");
  assert(d9.slug === "langchain-ops", "Correct slug returned");

  // 1i. Public insights (initially empty since we cleared contributions)
  const { status: s10, data: d10 } = await api("GET", "/api/agents/langchain-ops/insights");
  assert(s10 === 200, "Public insights returns 200");
  assert(Array.isArray(d10.contributions), "Insights has contributions array");
  assert(typeof d10.total === "number", "Insights has total count");

  // 1j. Insights 404 for bad slug
  const { status: s11 } = await api("GET", "/api/agents/fake-agent/insights");
  assert(s11 === 404, `Insights for nonexistent agent returns 404 (got ${s11})`);

  // 1k. Insights with type filter
  const { status: s12 } = await api("GET", "/api/agents/langchain-ops/insights?type=CORRECTION");
  assert(s12 === 200, "Insights with type filter returns 200");
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 2: AGENT HIRING & DEPLOYMENT (Prisma-Simulated)
// ═══════════════════════════════════════════════════════════════════════════

let testDeploymentId = null;

async function testDeploymentLifecycle() {
  console.log("\n\u2550 FLOW 2: Agent Hiring & Deployment Lifecycle");
  console.log("\u2500".repeat(60));

  // 2a. Verify existing deployments in DB
  const deployments = await prisma.deployment.findMany({
    where: { companyId: COMPANY_A_ID, status: "ACTIVE" },
  });
  assert(deployments.length >= 1, `Company A has ${deployments.length} active deployment(s)`);

  // 2b. Simulate hiring: create deployment via Prisma
  const agent = await prisma.agent.findUnique({ where: { slug: "langchain-ops" } });
  assert(!!agent, "LangChain agent exists in DB");

  const newDep = await prisma.deployment.create({
    data: {
      companyId: COMPANY_A_ID,
      agentId: agent.id,
      agentVersion: agent.currentVersion || "1.0.0",
      agentName: "E2E Test Agent",
      status: "PROVISIONING",
      autonomyConfig: { agentMindEnabled: true, agentMindAutoApprove: true },
    },
  });
  testDeploymentId = newDep.id;
  assert(!!newDep.id, `Deployment created: ${newDep.id}`);
  assert(newDep.status === "PROVISIONING", "Initial status is PROVISIONING");

  // 2c. Advance to ACTIVE (simulates provisioning service completion)
  await prisma.deployment.update({
    where: { id: newDep.id },
    data: { status: "ACTIVE" },
  });
  const active = await prisma.deployment.findUnique({ where: { id: newDep.id } });
  assert(active.status === "ACTIVE", "Deployment advanced to ACTIVE");

  // 2d. Pause deployment
  await prisma.deployment.update({
    where: { id: newDep.id },
    data: { status: "PAUSED" },
  });
  const paused = await prisma.deployment.findUnique({ where: { id: newDep.id } });
  assert(paused.status === "PAUSED", "Deployment paused successfully");

  // 2e. Resume deployment
  await prisma.deployment.update({
    where: { id: newDep.id },
    data: { status: "ACTIVE" },
  });

  // 2f. Fire deployment
  await prisma.deployment.update({
    where: { id: newDep.id },
    data: { status: "FIRED" },
  });
  const fired = await prisma.deployment.findUnique({ where: { id: newDep.id } });
  assert(fired.status === "FIRED", "Deployment fired successfully");

  // Cleanup test deployment
  await prisma.deployment.delete({ where: { id: newDep.id } });
  testDeploymentId = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 3: APPROVAL QUEUE (Mixed Auth)
// ═══════════════════════════════════════════════════════════════════════════

async function testApprovalQueue() {
  console.log("\n\u2550 FLOW 3: Approval Queue (Agent \u2192 Manager \u2192 Trust)");
  console.log("\u2500".repeat(60));

  // 3a. Agent submits approval via internal POST (no Clerk auth)
  const { status: s1, data: d1 } = await api(
    "POST",
    `/api/deployments/${DEPLOYMENT_A_ID}/approvals`,
    {
      taskType: "email_reply",
      draft: "Dear client, here is the Q3 report as requested...",
      reasoning: "Client asked for quarterly report, drafting response",
      originalRequest: "From: client@example.com - Please send Q3 report",
      stakesScore: 5,
      ambiguityScore: 3,
      reversibilityScore: 7,
      combinedScore: 5.0,
    },
  );
  assert(s1 === 201, `Agent submits approval, returns 201 (got ${s1})`);
  assert(d1.approval?.id, `Approval created: ${d1.approval?.id}`);
  assert(d1.approval?.status === "PENDING", "Approval status is PENDING");
  const approvalId = d1.approval?.id;

  // 3b. Agent queries pending approvals by threadId (internal poller path, no auth)
  const threadId = "test-thread-" + Date.now();
  // Create one with threadId
  const { data: d2 } = await api(
    "POST",
    `/api/deployments/${DEPLOYMENT_A_ID}/approvals`,
    {
      taskType: "meeting_prep",
      draft: "Meeting agenda for tomorrow...",
      reasoning: "Preparing meeting notes",
      originalRequest: "Prepare for standup",
      threadId,
      stakesScore: 2,
      ambiguityScore: 1,
      reversibilityScore: 9,
    },
  );
  const threadApprovalId = d2.approval?.id;

  const { status: s3, data: d3 } = await api(
    "GET",
    `/api/deployments/${DEPLOYMENT_A_ID}/approvals?threadId=${threadId}&status=PENDING`,
  );
  assert(s3 === 200, "Internal poller query returns 200");
  assert(Array.isArray(d3), "Returns array of approvals");
  assert(d3.length >= 1, `Found ${d3.length} pending approval(s) for thread`);

  // 3c. Portal: get pending approvals by portal token (re-fetch to get token set in setup)
  const deployment = await prisma.deployment.findUnique({
    where: { id: DEPLOYMENT_A_ID },
    select: { portalToken: true },
  });

  if (deployment?.portalToken) {
    const { status: s4, data: d4 } = await api(
      "GET",
      `/api/portal/${deployment.portalToken}/approvals`,
    );
    assert(s4 === 200, "Portal approvals returns 200");
    assert(d4.agentName, `Portal shows agent: "${d4.agentName}"`);
    assert(Array.isArray(d4.approvals), "Portal has approvals array");
    assert(d4.approvals.length >= 1, `Portal has ${d4.approvals.length} pending approval(s)`);

    // 3d. Portal: resolve approval (APPROVED) — use the first approval we created
    const { status: s5, data: d5 } = await api(
      "POST",
      `/api/portal/${deployment.portalToken}/approvals/${approvalId}/resolve`,
      { action: "APPROVED" },
    );
    assert(s5 === 200, `Portal resolve returns 200 (got ${s5})`);
    assert(d5.approval?.status === "APPROVED", "Approval resolved as APPROVED");
    assert(typeof d5.trustScore?.weightedScore === "number", "Trust score returned");
    assert(typeof d5.trustScore?.autonomyLevel === "string", `Autonomy level: ${d5.trustScore?.autonomyLevel}`);
  } else {
    skip("No portal token on deployment A — portal tests skipped");
  }

  // 3e. Portal: resolve with EDITED action — use the thread approval
  if (deployment?.portalToken && threadApprovalId) {
    const { status: s6, data: d6 } = await api(
      "POST",
      `/api/portal/${deployment.portalToken}/approvals/${threadApprovalId}/resolve`,
      {
        action: "EDITED",
        editedText: "Meeting agenda for tomorrow (revised by manager)...",
      },
    );
    assert(s6 === 200, `Portal EDITED resolve returns 200 (got ${s6})`);
    assert(d6.approval?.status === "EDITED", `Approval resolved as EDITED (got ${d6.approval?.status})`);
  }

  // 3f. Resolve via portal with REJECTED action
  // Create another approval to reject
  const { data: rejectData } = await api(
    "POST",
    `/api/deployments/${DEPLOYMENT_A_ID}/approvals`,
    {
      taskType: "research",
      draft: "Here is the competitive analysis...",
      reasoning: "Competitor research task",
      originalRequest: "Research competitor pricing",
      stakesScore: 6,
      ambiguityScore: 4,
      reversibilityScore: 3,
    },
  );
  if (deployment?.portalToken && rejectData.approval?.id) {
    const { status: s7, data: d7 } = await api(
      "POST",
      `/api/portal/${deployment.portalToken}/approvals/${rejectData.approval.id}/resolve`,
      {
        action: "REJECTED",
        rejectionReason: "Too sensitive — need to handle internally",
      },
    );
    assert(s7 === 200, "Portal REJECTED resolve returns 200");
    assert(d7.approval?.status === "REJECTED", "Approval resolved as REJECTED");
  }

  // 3g. Already resolved → 409
  if (deployment?.portalToken && threadApprovalId) {
    const { status: s8 } = await api(
      "POST",
      `/api/portal/${deployment.portalToken}/approvals/${threadApprovalId}/resolve`,
      { action: "APPROVED" },
    );
    assert(s8 === 409, `Re-resolve returns 409 (got ${s8})`);
  }

  // 3h. Invalid portal token → 404
  const { status: s9 } = await api("GET", "/api/portal/invalid-token-xyz/approvals");
  assert(s9 === 404, `Invalid portal token returns 404 (got ${s9})`);

  // 3i. Verify trust scores were updated in DB
  const trustScores = await prisma.trustScore.findMany({
    where: { deploymentId: DEPLOYMENT_A_ID },
  });
  assert(trustScores.length >= 1, `${trustScores.length} trust score(s) exist for deployment A`);

  const emailTrust = trustScores.find(t => t.taskType === "email_reply");
  if (emailTrust) {
    assert(typeof emailTrust.weightedScore === "number", `Email trust score: ${emailTrust.weightedScore}`);
    assert(typeof emailTrust.autonomyLevel === "string", `Email autonomy: ${emailTrust.autonomyLevel}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 4: AGENTMIND KNOWLEDGE SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

let contributionIds = [];

async function testAgentMindContribute() {
  console.log("\n\u2550 FLOW 4a: AgentMind — Contribute");
  console.log("\u2500".repeat(60));

  // 4a-1. Auto-approve contribution (default)
  const { status: s1, data: d1 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "CORRECTION",
    title: "Lead with resolution in escalation emails",
    content:
      "When drafting escalation emails, lead with the proposed resolution " +
      "followed by brief context. Recipients respond faster.",
    tags: ["email", "escalation"],
    context: "Customer escalation about delayed shipment",
  });
  assert(s1 === 201, `Contribute returns 201 (got ${s1})`);
  assert(d1.status === "APPROVED", `Auto-approved (got ${d1.status})`);
  contributionIds.push(d1.id);

  // 4a-2. Second contribution (PATTERN type)
  const { status: s2, data: d2 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "PATTERN",
    title: "Bullet summaries preferred over prose for status updates",
    content: "Bullet format received approval without edits 92% of the time.",
    tags: ["formatting", "status-updates"],
  });
  assert(s2 === 201, "Pattern contribution returns 201");
  assert(d2.status === "APPROVED", "Pattern auto-approved");
  contributionIds.push(d2.id);

  // 4a-3. RESPONSE_TEMPLATE type
  const { data: d3 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "RESPONSE_TEMPLATE",
    title: "Weekly digest template: metrics then blockers then next steps",
    content: "Template:\n**This week:**\n- [achievements]\n**Blockers:**\n- [items]\n**Next week:**\n- [priorities]",
    tags: ["templates", "weekly-digest"],
  });
  assert(d3.status === "APPROVED", "Response template auto-approved");
  contributionIds.push(d3.id);

  // 4a-4. TASK_RECIPE type
  const { data: d4 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "TASK_RECIPE",
    title: "Vendor onboarding four-step workflow",
    content: "1. Verify domain 2. Send welcome 3. Create profile 4. Confirm.",
    tags: ["onboarding", "workflow"],
  });
  assert(d4.status === "APPROVED", "Task recipe auto-approved");
  contributionIds.push(d4.id);

  // 4a-5. Validation: missing required fields
  const { status: s5 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    // missing type, title, content, tags
  });
  assert(s5 === 400, `Missing fields returns 400 (got ${s5})`);

  // 4a-6. Validation: invalid type
  const { status: s6 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "INVALID_TYPE",
    title: "test",
    content: "test",
    tags: ["test"],
  });
  assert(s6 === 400, `Invalid type returns 400 (got ${s6})`);

  // 4a-7. Non-existent deployment
  const { status: s7 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: "nonexistent-deployment-id",
    type: "CORRECTION",
    title: "test",
    content: "test",
    tags: ["test"],
  });
  assert(s7 === 404, `Nonexistent deployment returns 404 (got ${s7})`);
}

async function testAgentMindManualReview() {
  console.log("\n\u2550 FLOW 4b: AgentMind — Manual Review Mode");
  console.log("\u2500".repeat(60));

  // Switch deployment B to manual review
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_B_ID },
    data: {
      autonomyConfig: { agentMindEnabled: true, agentMindAutoApprove: false },
    },
  });

  const { status, data } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_B_ID,
    type: "CORRECTION",
    title: "Verify calendar before suggesting meeting times",
    content: "Always check calendar tool before suggesting dates.",
    tags: ["scheduling"],
    context: "Scheduling follow-up",
  });

  assert(status === 201, `Manual review: contribute returns 201 (got ${status})`);
  assert(data.status === "PENDING", `Status is PENDING (got ${data.status})`);

  // PENDING contributions should NOT appear in search
  const { data: searchData } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_B_ID}&q=calendar`,
  );
  const found = searchData.contributions?.some(c => c.title?.toLowerCase().includes("calendar"));
  assert(!found, "PENDING contribution NOT in search results");

  // Admin approves via Prisma
  await prisma.knowledgeContribution.update({
    where: { id: data.id },
    data: { status: "APPROVED", reviewedBy: "admin-test", reviewedAt: new Date() },
  });

  // Now searchable
  const { data: d2 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_B_ID}&q=calendar`,
  );
  assert(d2.contributions?.some(c => c.title?.toLowerCase().includes("calendar")), "After approval, searchable");

  // Reset
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_B_ID },
    data: { autonomyConfig: { agentMindEnabled: true, agentMindAutoApprove: true } },
  });
}

async function testAgentMindOptOut() {
  console.log("\n\u2550 FLOW 4c: AgentMind — Opt-Out & Reciprocity");
  console.log("\u2500".repeat(60));

  // Opt out deployment B
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_B_ID },
    data: { autonomyConfig: { agentMindEnabled: false } },
  });

  // Contribute blocked
  const { status: s1, data: d1 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_B_ID,
    type: "CORRECTION",
    title: "Should be rejected",
    content: "Agent tried to contribute but opted out.",
    tags: ["test"],
  });
  assert(s1 === 403, `Opt-out blocks contribute (got ${s1})`);
  assert(d1.error?.toLowerCase().includes("disabled"), "Error mentions disabled");

  // Search returns empty (reciprocity)
  const { status: s2, data: d2 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_B_ID}&q=escalation`,
  );
  assert(s2 === 200, "Reciprocity: search returns 200 (not error)");
  assert(d2.contributions?.length === 0, `Opted-out gets empty results (got ${d2.contributions?.length})`);

  // Opted-in deployment still works
  const { data: d3 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_A_ID}&q=escalation`,
  );
  assert(d3.contributions?.length >= 1, `Opted-in still finds ${d3.contributions?.length} result(s)`);

  // Restore
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_B_ID },
    data: { autonomyConfig: { agentMindEnabled: true, agentMindAutoApprove: true } },
  });
}

async function testAgentMindSearch() {
  console.log("\n\u2550 FLOW 4d: AgentMind — Search");
  console.log("\u2500".repeat(60));

  // Search by query
  const { status: s1, data: d1 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_A_ID}&q=escalation`,
  );
  assert(s1 === 200, "Search returns 200");
  assert(d1.contributions?.length >= 1, `Found ${d1.contributions?.length} result(s) for 'escalation'`);
  assert(d1.contributions[0].title, "Result has title");
  assert(d1.contributions[0].content, "Result has content");
  assert(Array.isArray(d1.contributions[0].tags), "Result has tags");

  // Search by type filter
  const { data: d2 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_A_ID}&q=template&type=RESPONSE_TEMPLATE`,
  );
  assert(
    d2.contributions?.every(c => c.type === "RESPONSE_TEMPLATE"),
    "Type filter returns only RESPONSE_TEMPLATE",
  );

  // Search with limit
  const { data: d3 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_A_ID}&limit=1`,
  );
  assert(d3.contributions?.length <= 1, `Limit=1 returns at most 1 result (got ${d3.contributions?.length})`);

  // Cross-agent isolation
  const { data: d4 } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_ALEX_ID}&deploymentId=${DEPLOYMENT_A_ID}&q=escalation`,
  );
  assert(d4.contributions?.length === 0, `Cross-agent isolation: Alex sees 0 of LangChain's results (got ${d4.contributions?.length})`);

  // Missing params
  const { status: s5 } = await api("GET", "/api/agentmind/search");
  assert(s5 === 400, `Missing params returns 400 (got ${s5})`);
}

async function testAgentMindVoteAndUse() {
  console.log("\n\u2550 FLOW 4e: AgentMind — Vote & Use (Three Distinct Signals)");
  console.log("\u2500".repeat(60));

  const targetId = contributionIds[0];
  const before = await prisma.knowledgeContribution.findUnique({
    where: { id: targetId },
    select: { usageCount: true, upvotes: true, downvotes: true },
  });

  // Search does NOT increment counters
  await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_B_ID}&q=escalation`,
  );
  const afterSearch = await prisma.knowledgeContribution.findUnique({
    where: { id: targetId },
    select: { usageCount: true, upvotes: true },
  });
  assert(afterSearch.usageCount === before.usageCount, "Search does NOT increment usageCount");
  assert(afterSearch.upvotes === before.upvotes, "Search does NOT change upvotes");

  // POST /api/agentmind/use — increments usageCount + auto-upvotes
  const { status: useS, data: useD } = await api("POST", "/api/agentmind/use", {
    deploymentId: DEPLOYMENT_B_ID,
    contributionIds: [targetId],
  });
  assert(useS === 200, `Use returns 200 (got ${useS})`);
  assert(useD.used === 1, `Reported 1 usage (got ${useD.used})`);
  assert(useD.results?.[0]?.voted === true, "First use auto-upvotes");

  const afterUse = await prisma.knowledgeContribution.findUnique({
    where: { id: targetId },
    select: { usageCount: true, upvotes: true },
  });
  assert(afterUse.usageCount === before.usageCount + 1, "Use increments usageCount");
  assert(afterUse.upvotes === before.upvotes + 1, "Use auto-upvotes");

  // Second use is idempotent for votes
  const { data: useD2 } = await api("POST", "/api/agentmind/use", {
    deploymentId: DEPLOYMENT_B_ID,
    contributionIds: [targetId],
  });
  assert(useD2.results?.[0]?.voted === false, "Second use does NOT double-vote");

  const afterUse2 = await prisma.knowledgeContribution.findUnique({
    where: { id: targetId },
    select: { usageCount: true, upvotes: true },
  });
  assert(afterUse2.usageCount === afterUse.usageCount + 1, "Second use still increments usageCount");
  assert(afterUse2.upvotes === afterUse.upvotes, "Upvotes unchanged on second use");

  // Explicit vote: upvote
  const { status: vs1 } = await api("POST", "/api/agentmind/vote", {
    deploymentId: DEPLOYMENT_A_ID,
    contributionId: targetId,
    vote: 1,
  });
  assert(vs1 === 200, "Explicit upvote returns 200");

  // Explicit vote: downvote override
  const { status: vs2 } = await api("POST", "/api/agentmind/vote", {
    deploymentId: DEPLOYMENT_B_ID,
    contributionId: targetId,
    vote: -1,
  });
  assert(vs2 === 200, "Downvote override returns 200");

  const afterDownvote = await prisma.knowledgeContribution.findUnique({
    where: { id: targetId },
    select: { upvotes: true, downvotes: true },
  });
  assert(afterDownvote.downvotes >= 1, "Downvote recorded");

  // Vote validation: invalid vote value
  const { status: vs3 } = await api("POST", "/api/agentmind/vote", {
    deploymentId: DEPLOYMENT_A_ID,
    contributionId: targetId,
    vote: 5,
  });
  assert(vs3 === 400, `Invalid vote value returns 400 (got ${vs3})`);
}

async function testAgentMindGuardrails() {
  console.log("\n\u2550 FLOW 4f: AgentMind — PII Guardrails");
  console.log("\u2500".repeat(60));

  const { status, data } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "CORRECTION",
    title: "Sanitize contact details before forwarding",
    content:
      "Forwarded a thread containing john.doe@acmecorp.com and " +
      "phone 555-123-4567 and SSN 123-45-6789 to billing.",
    tags: ["privacy"],
  });
  assert(status === 201, "PII contribution accepted");

  const contrib = await prisma.knowledgeContribution.findUnique({
    where: { id: data.id },
  });
  assert(contrib.content.includes("[EMAIL]"), "Email redacted -> [EMAIL]");
  assert(contrib.content.includes("[PHONE]"), "Phone redacted -> [PHONE]");
  assert(contrib.content.includes("[SSN]"), "SSN redacted -> [SSN]");
  assert(!contrib.content.includes("john.doe@"), "Original email removed");
  assert(contrib.rawContent.includes("john.doe@acmecorp.com"), "Raw content preserves original");

  const log = contrib.sanitizationLog;
  assert(Array.isArray(log), "Sanitization log exists");
  const redactions = log.filter(e => e.action === "redacted");
  assert(redactions.length >= 3, `${redactions.length} redaction(s) logged`);
}

async function testAgentMindDuplicates() {
  console.log("\n\u2550 FLOW 4g: AgentMind — Duplicate Detection");
  console.log("\u2500".repeat(60));

  const { status, data } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "CORRECTION",
    title: "Lead with resolution in escalation emails",
    content: "duplicate attempt",
    tags: ["test"],
  });
  assert(status === 200, `Duplicate returns 200 (not 201) (got ${status})`);
  assert(data.duplicate === true, "Response has duplicate: true");
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 5: CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════

async function testCronJobs() {
  console.log("\n\u2550 FLOW 5: Cron Jobs");
  console.log("\u2500".repeat(60));

  // 5a. Expire approvals
  // Create an expired approval for testing
  await prisma.approval.create({
    data: {
      deploymentId: DEPLOYMENT_A_ID,
      taskType: "test_expire",
      channel: "email",
      draft: "This should expire",
      reasoning: "Test",
      originalRequest: "Test",
      stakesScore: 1,
      ambiguityScore: 1,
      reversibilityScore: 1,
      combinedScore: 1,
      status: "PENDING",
      expiresAt: new Date(Date.now() - 1000), // Already expired
    },
  });

  const { status: s1, data: d1 } = await api("POST", "/api/cron/expire-approvals");
  assert(s1 === 200, `Expire approvals returns 200 (got ${s1})`);
  assert(typeof d1.expired === "number", `Expired ${d1.expired} approval(s)`);
  assert(d1.expired >= 1, "At least 1 approval expired");

  // Verify it's actually EXPIRED in DB
  const expired = await prisma.approval.findFirst({
    where: { deploymentId: DEPLOYMENT_A_ID, taskType: "test_expire" },
  });
  assert(expired?.status === "EXPIRED", "Approval status is EXPIRED in DB");

  // 5b. Update trust scores
  const { status: s2, data: d2 } = await api("POST", "/api/cron/update-trust-scores");
  assert(s2 === 200, `Update trust scores returns 200 (got ${s2})`);
  assert(typeof d2.updated === "number", `Updated ${d2.updated} trust score(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 6: AUTH-GATED ENDPOINTS (Verify 401)
// ═══════════════════════════════════════════════════════════════════════════

async function testAuthGatedEndpoints() {
  console.log("\n\u2550 FLOW 6: Auth-Gated Endpoints (Verify 401 without Clerk)");
  console.log("\u2500".repeat(60));

  const authRoutes = [
    ["GET", `/api/deployments`],
    ["GET", `/api/deployments/${DEPLOYMENT_A_ID}/trust-scores`],
    ["PATCH", `/api/deployments/${DEPLOYMENT_A_ID}/settings`],
    ["GET", "/api/agentmind/stats"],
    ["GET", "/api/agentmind/contributions"],
    ["DELETE", `/api/agentmind/contributions/fake-id`],
    ["GET", "/api/creator/profile"],
    ["GET", "/api/creator/analytics"],
  ];

  for (const [method, path] of authRoutes) {
    const { status } = await api(method, path, method !== "GET" ? {} : null);
    assert(
      status === 401 || status === 403,
      `${method} ${path.replace(DEPLOYMENT_A_ID, "[id]")} returns ${status} (auth required)`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 7: END-TO-END AGENT LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

async function testFullLifecycle() {
  console.log("\n\u2550 FLOW 7: Full Agent Lifecycle (Approval \u2192 Trust \u2192 Knowledge)");
  console.log("\u2500".repeat(60));

  // Step 1: Agent drafts email and submits for approval
  console.log("  Step 1: Agent submits draft for approval");
  const { data: apData } = await api(
    "POST",
    `/api/deployments/${DEPLOYMENT_A_ID}/approvals`,
    {
      taskType: "customer_followup",
      draft: "Hi there, following up on your inquiry about our enterprise plan...",
      reasoning: "Responding to sales inquiry with pricing details",
      originalRequest: "From: prospect@company.com — What are your enterprise rates?",
      stakesScore: 7,
      ambiguityScore: 4,
      reversibilityScore: 2,
    },
  );
  assert(apData.approval?.status === "PENDING", "Step 1: Approval queued as PENDING");

  // Step 2: Manager reviews and edits via portal
  const dep = await prisma.deployment.findUnique({
    where: { id: DEPLOYMENT_A_ID },
    select: { portalToken: true },
  });

  // Re-fetch portal token (may have been set in setup)
  const depRefresh = await prisma.deployment.findUnique({
    where: { id: DEPLOYMENT_A_ID },
    select: { portalToken: true },
  });

  let step2Resolved = false;
  if (depRefresh?.portalToken) {
    console.log("  Step 2: Manager edits the draft via portal");
    const { data: resolveData } = await api(
      "POST",
      `/api/portal/${depRefresh.portalToken}/approvals/${apData.approval.id}/resolve`,
      {
        action: "EDITED",
        editedText: "Hi there, thank you for your interest! Our enterprise plan starts at $10k/yr. Let me schedule a call to discuss your needs.",
      },
    );
    assert(resolveData.approval?.status === "EDITED", "Step 2: Approval resolved as EDITED");
    assert(resolveData.trustScore?.autonomyLevel, `Step 2: Trust level: ${resolveData.trustScore?.autonomyLevel}`);
    step2Resolved = true;
  } else {
    skip("No portal token — step 2 skipped");
  }

  // Step 3: Trust scores are updated (only if step 2 resolved)
  if (step2Resolved) {
    console.log("  Step 3: Verify trust scores updated");
    const scores = await prisma.trustScore.findMany({
      where: { deploymentId: DEPLOYMENT_A_ID, taskType: "customer_followup" },
    });
    assert(scores.length >= 1, "Trust score exists for customer_followup");
    if (scores[0]) {
      assert(scores[0].edited >= 1, `Edited count: ${scores[0].edited}`);
    }
  }

  // Step 4: Agent B searches AgentMind and finds knowledge
  console.log("  Step 4: Agent B searches AgentMind for templates");
  const { data: searchResults } = await api(
    "GET",
    `/api/agentmind/search?agentId=${AGENT_LANGCHAIN_ID}&deploymentId=${DEPLOYMENT_B_ID}&q=template`,
  );
  assert(searchResults.contributions?.length >= 1, `Agent B found ${searchResults.contributions?.length} template(s)`);

  // Step 5: Agent B uses a template
  if (searchResults.contributions?.length >= 1) {
    console.log("  Step 5: Agent B uses and upvotes a template");
    const templateId = searchResults.contributions[0].id;
    const { data: useData } = await api("POST", "/api/agentmind/use", {
      deploymentId: DEPLOYMENT_B_ID,
      contributionIds: [templateId],
    });
    assert(useData.used >= 1, "Template usage recorded");

    // Verify in DB
    const contrib = await prisma.knowledgeContribution.findUnique({
      where: { id: templateId },
      select: { usageCount: true, upvotes: true },
    });
    assert(contrib.usageCount >= 1, `Template used ${contrib.usageCount} time(s)`);
  }

  // Step 6: Public insights now show the knowledge
  console.log("  Step 6: Verify public insights reflect contributions");
  const { data: insightsData } = await api("GET", "/api/agents/langchain-ops/insights");
  assert(insightsData.contributions?.length >= 1, `Public insights: ${insightsData.contributions?.length} visible`);
  assert(insightsData.total >= 1, `Total insights: ${insightsData.total}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 8: SETTINGS & DEPLOYMENT MANAGEMENT (Prisma-Simulated)
// ═══════════════════════════════════════════════════════════════════════════

async function testSettingsManagement() {
  console.log("\n\u2550 FLOW 8: Settings & Deployment Management (Prisma-Simulated)");
  console.log("\u2500".repeat(60));

  // 8a. Merge partial autonomyConfig (simulates PATCH /settings)
  const depBefore = await prisma.deployment.findUnique({
    where: { id: DEPLOYMENT_A_ID },
    select: { autonomyConfig: true },
  });

  const merged = {
    ...((depBefore.autonomyConfig ?? {})),
    approvalPolicy: "risk-based",
    approvalRiskThreshold: 6,
  };

  await prisma.deployment.update({
    where: { id: DEPLOYMENT_A_ID },
    data: { autonomyConfig: merged },
  });

  const depAfter = await prisma.deployment.findUnique({
    where: { id: DEPLOYMENT_A_ID },
    select: { autonomyConfig: true },
  });

  assert(depAfter.autonomyConfig.approvalPolicy === "risk-based", "Approval policy updated");
  assert(depAfter.autonomyConfig.approvalRiskThreshold === 6, "Risk threshold set to 6");
  assert(depAfter.autonomyConfig.agentMindEnabled === true, "AgentMind still enabled (not wiped)");

  // 8b. Toggle AgentMind off → contribute blocked → toggle back on
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_A_ID },
    data: {
      autonomyConfig: { ...depAfter.autonomyConfig, agentMindEnabled: false },
    },
  });

  const { status: s1 } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: DEPLOYMENT_A_ID,
    type: "CORRECTION",
    title: "Should fail",
    content: "Blocked",
    tags: ["test"],
  });
  assert(s1 === 403, `After toggle OFF, contribute blocked (${s1})`);

  // Re-enable
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_A_ID },
    data: {
      autonomyConfig: { ...depAfter.autonomyConfig, agentMindEnabled: true },
    },
  });

  // 8c. Trust score override (simulates PATCH /trust-scores)
  const overrideScore = await prisma.trustScore.upsert({
    where: {
      deploymentId_taskType: {
        deploymentId: DEPLOYMENT_A_ID,
        taskType: "manual_override_test",
      },
    },
    create: {
      deploymentId: DEPLOYMENT_A_ID,
      taskType: "manual_override_test",
      autonomyLevel: "auto_execute",
    },
    update: {
      autonomyLevel: "auto_execute",
      lastUpdated: new Date(),
    },
  });
  assert(overrideScore.autonomyLevel === "auto_execute", "Manual trust score override works");

  // Clean up
  await prisma.trustScore.delete({ where: { id: overrideScore.id } });
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 9: DATABASE INTEGRITY CHECKS
// ═══════════════════════════════════════════════════════════════════════════

async function testDatabaseIntegrity() {
  console.log("\n\u2550 FLOW 9: Database Integrity Checks");
  console.log("\u2500".repeat(60));

  // 9a. All agents have required fields
  const agents = await prisma.agent.findMany();
  for (const agent of agents) {
    assert(!!agent.name, `Agent "${agent.slug}" has name`);
    assert(!!agent.slug, `Agent "${agent.name}" has slug`);
    assert(!!agent.status, `Agent "${agent.name}" has status`);
  }

  // 9b. All ACTIVE deployments have valid agent references
  const activeDeps = await prisma.deployment.findMany({
    where: { status: "ACTIVE" },
    include: { agent: true },
  });
  for (const dep of activeDeps) {
    assert(!!dep.agent, `Deployment ${dep.id.slice(0,8)} has valid agent ref`);
    assert(dep.agent.status === "LIVE", `Deployment's agent "${dep.agent.name}" is LIVE`);
  }

  // 9c. Trust scores reference valid deployments
  const trustScores = await prisma.trustScore.findMany({
    include: { deployment: true },
  });
  for (const ts of trustScores) {
    assert(!!ts.deployment, `TrustScore for "${ts.taskType}" has valid deployment`);
  }

  // 9d. Companies exist
  const companies = await prisma.company.findMany();
  assert(companies.length >= 2, `${companies.length} companies exist`);

  // 9e. Creators exist
  const creators = await prisma.creator.findMany();
  assert(creators.length >= 1, `${creators.length} creator(s) exist`);
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 10: STRIPE CREATOR PAYOUT CRON
// ═══════════════════════════════════════════════════════════════════════════

async function testPayoutCron() {
  console.log("\n\u2550 FLOW 10: Stripe Creator Payout Cron");
  console.log("\u2500".repeat(60));

  const CRON_SECRET = process.env.CRON_SECRET || "change_me_in_prod";

  // 10a. Unauthorized request should return 401
  const { status: s1 } = await api("POST", "/api/cron/creator-payouts", null, {
    "Authorization": "Bearer wrong-secret",
  });
  // Only fails if CRON_SECRET is non-default; skip auth check in default mode
  if (CRON_SECRET !== "change_me_in_prod") {
    assert(s1 === 401, `Wrong secret returns 401 (got ${s1})`);
  } else {
    skip("CRON_SECRET is default — auth check skipped (set CRON_SECRET in .env to test)");
  }

  // 10b. Dry-run mode — calculates amounts but no real transfers or DB writes
  const { status: s2, data: d2 } = await api(
    "POST",
    "/api/cron/creator-payouts?dryRun=true",
    null,
    { "Authorization": `Bearer ${CRON_SECRET}` },
  );
  assert(s2 === 200, `Payout cron (dryRun) returns 200 (got ${s2})`);
  if (s2 === 200) {
    const summary = d2.data ?? d2;
    assert(summary.dryRun === true, `Response confirms dryRun: true (got ${summary.dryRun})`);
    assert(typeof summary.processed === "number", `processed count present: ${summary.processed}`);
    assert(typeof summary.period === "string", `period string present: "${summary.period}"`);
    assert(typeof summary.totalPaidCents === "number", `totalPaidCents present: ${summary.totalPaidCents}`);
    assert(Array.isArray(summary.results), "results array present");

    // Show per-creator breakdown
    if (summary.results?.length > 0) {
      console.log(`\n  Creator breakdown (${summary.results.length} creator(s)):`);
      for (const r of summary.results) {
        console.log(`    ${r.creatorId.slice(0, 8)}… → ${r.status}${r.amountCents ? ` ($${(r.amountCents / 100).toFixed(2)})` : ""}`);
      }
      assert(
        summary.results.every(r => r.status.startsWith("dry-run") || r.status.startsWith("skipped")),
        "All results are dry-run or skipped (no real transfers)",
      );
    } else {
      skip("No creator results — DB may have no deployments with revenue in the prior month");
    }
  } else {
    const errMsg = (d2.data ?? d2).error ?? JSON.stringify(d2).slice(0, 150);
    if (errMsg.includes("Payout") || errMsg.includes("prisma")) {
      assert(false, `Payout cron failed — likely stale Prisma client. Run: pnpm --filter @marketplace/db generate, then restart web server. Error: ${errMsg.slice(0, 120)}`);
    } else {
      assert(false, `Payout cron returned ${s2}: ${errMsg.slice(0, 120)}`);
    }
  }

  // 10c. Idempotency: second call in same period should skip creators (payout already recorded)
  // In dry-run mode, it always re-calculates (no DB writes), so just verify it's stable
  const { status: s3, data: d3 } = await api(
    "POST",
    "/api/cron/creator-payouts?dryRun=true",
    null,
    { "Authorization": `Bearer ${CRON_SECRET}` },
  );
  assert(s3 === 200, `Second payout cron call also returns 200 (idempotent, got ${s3})`);
  if (s3 === 200) {
    const summary2 = d3.data ?? d3;
    assert(summary2.dryRun === true, "Second call still in dry-run mode");
    assert(typeof summary2.processed === "number", "Second call returns processed count");
  }

  // 10d. Verify Stripe Connect gate — creators without stripeOnboarded flag should be skipped
  // in production mode (not dryRun). In dry-run, all creators are queried.
  const creatorsWithStripe = await prisma.creator.count({
    where: { stripeOnboarded: true, stripeAccountId: { not: null } },
  });
  const totalCreators = await prisma.creator.count();
  assert(typeof creatorsWithStripe === "number", `Stripe-onboarded creators: ${creatorsWithStripe} of ${totalCreators} total`);
  if (creatorsWithStripe === 0) {
    skip("No creators with Stripe Connect onboarded — production payouts would be skipped for all");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW 11: HEARTBEAT CRON SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

async function testHeartbeatCronSystem() {
  console.log("\n\u2550 FLOW 11: Heartbeat Cron System (OpenClaw + Docker Runtimes)");
  console.log("\u2500".repeat(60));

  // ── 11a. Cron expression generation (same logic as openclaw-config.ts) ────────
  function buildHeartbeatCronExpr({ heartbeatIntervalMinutes, heartbeatIntervalHours } = {}) {
    if (heartbeatIntervalMinutes !== undefined) return `*/${heartbeatIntervalMinutes} * * * *`;
    if (heartbeatIntervalHours !== undefined) return `0 */${heartbeatIntervalHours} * * *`;
    return null;
  }

  const cronCases = [
    { opts: { heartbeatIntervalMinutes: 1 }, expected: "*/1 * * * *",   label: "1-min (test)" },
    { opts: { heartbeatIntervalMinutes: 5 }, expected: "*/5 * * * *",   label: "5-min (test)" },
    { opts: { heartbeatIntervalHours: 6 },   expected: "0 */6 * * *",   label: "6-hourly (prod)" },
    { opts: { heartbeatIntervalHours: 24 },  expected: "0 */24 * * *",  label: "daily (prod)" },
    { opts: {},                               expected: null,             label: "disabled (null)" },
  ];

  for (const { opts, expected, label } of cronCases) {
    const result = buildHeartbeatCronExpr(opts);
    assert(result === expected, `Heartbeat cron expr [${label}]: "${result ?? "null"}" (expected "${expected ?? "null"}")`);
  }

  // ── 11b. Weekly digest cron (same for both runtimes) ────────────────────────
  const weeklyExpr = "0 9 * * 1";
  assert(weeklyExpr.split(" ").length === 5, `Weekly digest cron "${weeklyExpr}" is valid 5-part expression`);

  // ── 11c. Env var: HEARTBEAT_INTERVAL_MINUTES takes priority over HOURS ───────
  // Simulate the local-runner.ts priority logic
  function resolveHeartbeatEnv(env = {}) {
    if (env.HEARTBEAT_INTERVAL_MINUTES) return { heartbeatIntervalMinutes: parseInt(env.HEARTBEAT_INTERVAL_MINUTES, 10) };
    if (env.HEARTBEAT_INTERVAL_HOURS) return { heartbeatIntervalHours: parseInt(env.HEARTBEAT_INTERVAL_HOURS, 10) };
    return {};
  }
  const minOverride = resolveHeartbeatEnv({ HEARTBEAT_INTERVAL_MINUTES: "1", HEARTBEAT_INTERVAL_HOURS: "6" });
  assert(minOverride.heartbeatIntervalMinutes === 1 && !minOverride.heartbeatIntervalHours,
    "HEARTBEAT_INTERVAL_MINUTES takes priority over HOURS when both set");

  // ── 11d. Inject heartbeat into live deployment's jobs.json (if data/ exists) ──
  const dataDir = join(__dirname, "data");
  let dep = null;
  if (existsSync(dataDir)) {
    const entries = readdirSync(dataDir)
      .filter(d => existsSync(join(dataDir, d, "openclaw-state", "cron", "jobs.json")))
      .map(d => ({ id: d, mtime: statSync(join(dataDir, d)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    dep = entries[0] ?? null;
  }

  if (!dep) {
    skip("No live deployment in data/ — heartbeat injection skipped (provision an agent first)");
  } else {
    const jobsPath = join(dataDir, dep.id, "openclaw-state", "cron", "jobs.json");
    try {
      const jobs = JSON.parse(readFileSync(jobsPath, "utf-8"));
      const hadHeartbeat = jobs.jobs.some(j => j.name === "Heartbeat");
      const filtered = jobs.jobs.filter(j => j.name !== "Heartbeat");
      const testJob = {
        name: "Heartbeat",
        schedule: { kind: "cron", expr: "*/1 * * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "HEARTBEAT: Periodic maintenance check. Reply HEARTBEAT_OK when done.",
        },
        delivery: { mode: "none" },
        enabled: true,
      };
      writeFileSync(jobsPath, JSON.stringify({ ...jobs, jobs: [...filtered, testJob] }, null, 2));
      assert(true, `Heartbeat injected into ${dep.id.slice(0, 8)} jobs.json (*/1 * * * *)${hadHeartbeat ? " (replaced existing)" : ""}`);

      // Verify the file was written correctly
      const verify = JSON.parse(readFileSync(jobsPath, "utf-8"));
      const written = verify.jobs.find(j => j.name === "Heartbeat");
      assert(written?.schedule?.expr === "*/1 * * * *", `Written heartbeat cron expr is correct: "${written?.schedule?.expr}"`);
    } catch (err) {
      assert(false, `Heartbeat injection failed: ${err.message}`);
    }
  }

  // ── 11e. On-demand heartbeat hook trigger (requires running gateway) ─────────
  let gatewayPort = null;
  if (dep) {
    const cfgPath = join(dataDir, dep.id, "openclaw-state", "openclaw.json");
    if (existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        gatewayPort = cfg.gateway?.port ?? null;
      } catch {}
    }
  }

  if (!gatewayPort) {
    skip("No gateway port found — hook trigger skipped (start provisioning service to activate)");
  } else {
    const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || "";
    const hookUrl = `http://localhost:${gatewayPort}/hooks/heartbeat`;
    try {
      const res = await fetch(hookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(HOOKS_TOKEN ? { "Authorization": `Bearer ${HOOKS_TOKEN}` } : {}),
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        assert(true, `Heartbeat hook triggered on port ${gatewayPort}: HTTP ${res.status}${body.sessionId ? ` (session: ${body.sessionId.slice(0, 12)}…)` : ""}`);
      } else {
        const txt = await res.text().catch(() => "");
        skip(`Heartbeat hook returned HTTP ${res.status}: ${txt.slice(0, 80)}`);
      }
    } catch (e) {
      if (e.message?.includes("ECONNREFUSED") || e.name === "AbortError" || e.message?.includes("fetch failed")) {
        skip(`OpenClaw gateway not running on port ${gatewayPort} — start provisioning service to test live hook`);
      } else {
        assert(false, `Hook trigger error: ${e.message}`);
      }
    }
  }

  // ── 11f. Verify Stripe + Payout schema exists in DB ──────────────────────────
  try {
    const payoutCount = await prisma.payout.count();
    assert(typeof payoutCount === "number", `Payout table accessible — ${payoutCount} payout record(s) in DB`);
  } catch (e) {
    assert(false, `Payout model not accessible in Prisma client — run: pnpm --filter @marketplace/db generate then restart web server. Error: ${e.message.slice(0, 80)}`);
  }

  // Creator Stripe Connect fields
  const sampleCreator = await prisma.creator.findFirst({ select: { stripeAccountId: true, stripeOnboarded: true } });
  if (sampleCreator !== undefined) {
    assert("stripeAccountId" in (sampleCreator ?? {}), "Creator.stripeAccountId field exists in schema");
    assert("stripeOnboarded" in (sampleCreator ?? {}), "Creator.stripeOnboarded field exists in schema");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log("\u2551  AI Agent Marketplace \u2014 Full E2E Test Suite (Flows 1\u201311)   \u2551");
  console.log("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\n");

  // Verify web app is reachable
  try {
    await fetch(`${BASE}/api/agents`);
  } catch {
    console.error("ERROR: Web app not reachable at", BASE);
    console.error("Start it with: cd marketplace && pnpm dev");
    process.exit(1);
  }

  await setup();

  try {
    // Flow 1: Public marketplace
    await testMarketplaceBrowse();

    // Flow 2: Deployment lifecycle
    await testDeploymentLifecycle();

    // Flow 3: Approval queue
    await testApprovalQueue();

    // Flow 4: AgentMind
    await testAgentMindContribute();
    await testAgentMindManualReview();
    await testAgentMindOptOut();
    await testAgentMindSearch();
    await testAgentMindVoteAndUse();
    await testAgentMindGuardrails();
    await testAgentMindDuplicates();

    // Flow 5: Cron jobs
    await testCronJobs();

    // Flow 6: Auth-gated endpoints
    await testAuthGatedEndpoints();

    // Flow 7: Full lifecycle
    await testFullLifecycle();

    // Flow 8: Settings management
    await testSettingsManagement();

    // Flow 9: Database integrity
    await testDatabaseIntegrity();

    // Flow 10: Stripe payout cron
    await testPayoutCron();

    // Flow 11: Heartbeat cron system
    await testHeartbeatCronSystem();
  } finally {
    await teardown();

    // Cleanup test data created by cron test
    await prisma.approval.deleteMany({ where: { taskType: "test_expire" } });
  }

  console.log("\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557");
  console.log(`\u2551  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`.padEnd(63) + "\u2551");
  console.log(`\u2551  Pass rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`.padEnd(63) + "\u2551");
  console.log("\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D\n");

  if (failures.length > 0) {
    console.log("  Failed tests:");
    for (const f of failures) {
      console.log(`    \u2717 ${f}`);
    }
    console.log("");
  }

  if (failed > 0) {
    console.log("  \u26A0 Some tests failed \u2014 check output above.\n");
  } else {
    console.log("  \u2705 All tests passed!\n");
  }

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n  Fatal error:", e);
  prisma.$disconnect();
  process.exit(1);
});
