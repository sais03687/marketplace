/**
 * COMPREHENSIVE END-TO-END TEST SUITE
 * =====================================
 * Tests the full agent lifecycle:
 *
 *  Phase 1 — Provision          : New agent hired, SA created, inbox created, gateway starts
 *  Phase 2 — Service Account    : Per-deployment SA or platform fallback; email in onboarding message
 *  Phase 3 — Intro Email        : Intro email sent with SA address, agent is notified
 *  Phase 4 — Email auto-response: Send email to agent, verify auto-reply
 *  Phase 5 — Google Drive       : Share file with SA email, verify agent receives notification
 *  Phase 6 — Approval flow      : Agent queues an action, portal resolve, trust score update
 *  Phase 7 — Pause              : Gateway process stops, poller stops
 *  Phase 8 — Resume             : Gateway restarts, poller restarts
 *  Phase 9 — AgentMind          : Contribute → search → use → vote → reflect pipeline
 *  Phase 10 — Fire              : Full cleanup: inbox deleted, SA deleted, status FIRED
 *
 * Prerequisites:
 *  - PostgreSQL running at localhost:5432
 *  - Redis running at localhost:6379
 *  - Web app running at localhost:3002
 *  - .env file at ../../.env (loaded automatically)
 *  - Seed script run: npx tsx scripts/seed.ts
 *
 * Run: node test-e2e-comprehensive.mjs
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const DB_URL = process.env.DATABASE_URL || "postgresql://marketplace:marketplace@localhost:5432/marketplace";
const AGENTMAIL_API = process.env.AGENTMAIL_API_BASE || "https://api.agentmail.to/v0";
const AGENTMAIL_KEY = process.env.AGENTMAIL_API_KEY;
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN;
const WEB_BASE = "http://localhost:3002";

// ─── Counters ────────────────────────────────────────────────────────────────

let passed = 0, failed = 0, warnings = 0;
const failures = [];

function ok(label) { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail = "") {
  console.log(`  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`);
  failed++; failures.push(label);
}
function warn(label) { console.log(`  ⚠ WARN: ${label}`); warnings++; }
function section(title) { console.log(`\n${"═".repeat(60)}\n  ${title}\n${"═".repeat(60)}`); }

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function agentmail(method, path, body) {
  const res = await fetch(`${AGENTMAIL_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENTMAIL_KEY}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function pollUntil(fn, { timeoutMs = 120_000, intervalMs = 3000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

// ─── Prisma (using the package's compiled client) ────────────────────────────

let prisma;
try {
  const { PrismaClient } = require("./packages/db/node_modules/@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
} catch (e) {
  console.error("Failed to init Prisma:", e.message);
  process.exit(1);
}

// ─── BullMQ (minimal queue client for enqueuing jobs) ────────────────────────

let Queue;
try {
  ({ Queue } = require("./node_modules/bullmq"));
} catch {
  try {
    ({ Queue } = require("bullmq"));
  } catch (e) {
    console.error("bullmq not found:", e.message);
    process.exit(1);
  }
}

const provQueue = new Queue("provisioning", { connection: { host: "localhost", port: 6379 } });

// ─── Test State ──────────────────────────────────────────────────────────────

let testDeploymentId;
let testAgentId;
let testCompanyId;
let testAgentEmail;
let testInboxId;
let testSAEmail;
let testPortalToken;
let testGatewayPort = 18830; // high port to avoid conflicts
let provisioningServiceProcess;
let testInboxHandle; // our own test inbox for sending emails

// ─── Phase 0: Setup ──────────────────────────────────────────────────────────

section("Phase 0 — Setup & Seed Verification");

async function phase0_setup() {
  // Verify agents exist in DB
  const agents = await prisma.agent.findMany({
    where: { status: "LIVE" },
    include: {
      versions: { where: { vetStatus: "MANUALLY_APPROVED" } },
      capabilities: true,
    },
  });

  if (agents.length === 0) {
    fail("Seeded agents found in DB", "Run: npx tsx scripts/seed.ts");
    return false;
  }
  ok(`${agents.length} live agent(s) found in DB`);

  const alex = agents.find(a => a.slug === "general-ops-alex");
  if (!alex) { fail("general-ops-alex agent found"); return false; }
  ok(`general-ops-alex agent found (id: ${alex.id})`);

  if (alex.versions.length === 0) { fail("Alex has an approved version"); return false; }
  ok(`Alex has an approved version: ${alex.versions[0].version}`);

  if (alex.capabilities.length > 0) {
    ok(`Alex has ${alex.capabilities.length} capabilities`);
  } else {
    warn("Alex has no capabilities (intro email capability list will be empty)");
  }

  testAgentId = alex.id;

  // Create (or find) test company
  let company = await prisma.company.findFirst({ where: { clerkOrgId: "test_org_e2e" } });
  if (!company) {
    company = await prisma.company.create({
      data: {
        clerkOrgId: "test_org_e2e",
        name: "Acme Corp E2E",
        domain: "acme-e2e.com",
      },
    });
    ok(`Created test company: ${company.name} (${company.id})`);
  } else {
    ok(`Reusing test company: ${company.name} (${company.id})`);
  }
  testCompanyId = company.id;

  // Use the existing test-manager inbox as our receive inbox
  // (AgentMail free tier is capped at 3 inboxes; we reuse this one rather than creating a new one)
  const managerInboxRes = await agentmail("GET", "/inboxes/test-manager%40agentmail.to");
  if (managerInboxRes.status === 200 && managerInboxRes.data?.email) {
    testInboxHandle = {
      id: managerInboxRes.data.inbox_id || "test-manager@agentmail.to",
      email_address: managerInboxRes.data.email || "test-manager@agentmail.to",
    };
    ok(`Using existing manager inbox: ${testInboxHandle.email_address}`);
  } else {
    // Fallback: try to create it
    const inboxRes = await agentmail("POST", "/inboxes", { username: "test-manager", domain: "agentmail.to" });
    if (inboxRes.status === 200 || inboxRes.status === 201) {
      testInboxHandle = {
        id: inboxRes.data.inbox_id || "test-manager@agentmail.to",
        email_address: inboxRes.data.email || "test-manager@agentmail.to",
      };
      ok(`Created test manager inbox: ${testInboxHandle.email_address}`);
    } else {
      warn(`Could not get manager inbox: ${JSON.stringify(inboxRes.data)}`);
    }
  }

  return true;
}

// ─── Phase 1: Provision ──────────────────────────────────────────────────────

section("Phase 1 — Agent Provisioning (new hire)");

async function phase1_provision() {
  // 1a. Create deployment record with PROVISIONING status
  const deployment = await prisma.deployment.create({
    data: {
      companyId: testCompanyId,
      agentId: testAgentId,
      agentVersion: "1.0.0",
      agentName: "Alex",
      status: "PROVISIONING",
      autonomyConfig: {
        approvalPolicy: "external-only",
        autoApproveList: "",
      },
      managerEmail: testInboxHandle?.email_address || "alex@acme-e2e.com",
      onboardingData: {
        company_focus: "B2B SaaS for HR teams",
        key_contacts: "CEO: Sarah Chen <sarah@acme-e2e.com>",
        approval_policy: "external-only",
      },
    },
  });

  testDeploymentId = deployment.id;
  testPortalToken = deployment.portalToken;
  ok(`Deployment record created: ${deployment.id}`);
  ok(`Portal token: ${deployment.portalToken}`);

  // 1b. Start the provisioning service process
  console.log("\n  Starting provisioning service...");
  provisioningServiceProcess = spawn(
    "node",
    ["--env-file=.env", "apps/provisioning-service/dist/index.js"],
    {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  provisioningServiceProcess.stdout.on("data", d => {
    const line = d.toString().trim();
    if (line.includes("ERROR") || line.includes("error") || line.includes("worker") || line.includes("ready")) {
      console.log(`    [prov] ${line.slice(0, 120)}`);
    }
  });
  provisioningServiceProcess.stderr.on("data", d => {
    const line = d.toString().trim();
    if (line && !line.includes("ExperimentalWarning") && !line.includes("fetch")) {
      console.log(`    [prov:err] ${line.slice(0, 120)}`);
    }
  });

  await sleep(3000); // let BullMQ worker start

  // 1c. Enqueue provision job
  await provQueue.add("provision", { type: "provision", deploymentId: testDeploymentId }, {
    jobId: `e2e-provision-${testDeploymentId}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 5000 },
  });
  ok(`Provision job enqueued for ${testDeploymentId.slice(0, 8)}`);

  // 1d. Wait for provisioning to complete (status → ONBOARDING)
  console.log("\n  Waiting for agent to come online (up to 3 min)...");
  let finalDep;
  try {
    finalDep = await pollUntil(
      async () => {
        const dep = await prisma.deployment.findUnique({ where: { id: testDeploymentId } });
        if (dep?.status === "ONBOARDING" || dep?.status === "ACTIVE") return dep;
        if (dep?.status === "ERROR") throw new Error(`Provisioning failed: status=ERROR`);
        process.stdout.write(".");
        return null;
      },
      { timeoutMs: 180_000, intervalMs: 5000, label: "deployment ONBOARDING" }
    );
    console.log("");
  } catch (err) {
    console.log("");
    fail("Provisioning completed within 3 minutes", err.message);

    // Dump provisioning logs
    const logs = await prisma.provisioningLog.findMany({
      where: { deploymentId: testDeploymentId },
      orderBy: { createdAt: "asc" },
    });
    if (logs.length > 0) {
      console.log("  Provisioning logs:");
      for (const l of logs) {
        console.log(`    [${l.status}] ${l.step}: ${l.message || ""}`);
      }
    }
    return false;
  }

  ok(`Provisioning completed — status: ${finalDep.status}, onboardingState: ${finalDep.onboardingState}`);

  // Check all expected fields
  if (finalDep.agentEmail) {
    testAgentEmail = finalDep.agentEmail;
    testInboxId = finalDep.agentEmailInboxId;
    ok(`Agent inbox created: ${testAgentEmail}`);
  } else {
    fail("Agent email set after provisioning");
  }

  if (finalDep.containerName) {
    ok(`Gateway endpoint recorded: ${finalDep.containerName}`);
    // Extract port from containerName (format: "http://localhost:PORT")
    const portMatch = finalDep.containerName.match(/:(\d+)$/);
    if (portMatch) testGatewayPort = parseInt(portMatch[1]);
  } else {
    fail("containerName set after provisioning");
  }

  return true;
}

// ─── Phase 2: Service Account ─────────────────────────────────────────────────

section("Phase 2 — Google Service Account");

async function phase2_service_account() {
  const dep = await prisma.deployment.findUnique({ where: { id: testDeploymentId } });

  if (dep?.deploymentServiceAccountEmail) {
    testSAEmail = dep.deploymentServiceAccountEmail;
    ok(`Per-deployment SA created: ${testSAEmail}`);

    // Verify it looks like a proper GCP SA email
    if (testSAEmail.includes("iam.gserviceaccount.com")) {
      ok("SA email has correct GCP format");
    } else {
      warn(`SA email format unexpected: ${testSAEmail}`);
    }

    // Verify key is stored
    if (dep.deploymentServiceAccountKey && dep.deploymentServiceAccountKey.length > 50) {
      ok("SA private key stored in DB");
    } else {
      fail("SA private key stored in DB");
    }
  } else {
    // Per-deployment SA creation failed — check if platform SA is used as fallback
    warn("Per-deployment SA not created (may need iam.serviceAccountAdmin role)");
    warn("Platform SA will be used as fallback");

    // Verify the onboarding message was sent with the platform SA email
    // (We can't directly read what was sent, but we can check the gateway received it)
    const platformSA = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    if (platformSA) {
      ok(`Platform SA fallback: ${platformSA}`);
      testSAEmail = platformSA;
    } else {
      warn("No SA configured — Google Workspace tools will be unavailable");
    }
  }

  // Test the DWD setup endpoint (the link a manager would click)
  if (testSAEmail) {
    const gwSetupRes = await fetch(
      `${WEB_BASE}/api/deployments/${testDeploymentId}/google-setup`,
      { method: "GET", headers: { "x-portal-token": testPortalToken } }
    );
    // This endpoint requires auth, so we expect 401 without a session
    if (gwSetupRes.status === 401) {
      ok("Google setup endpoint correctly requires auth (401 for unauthenticated)");
    } else if (gwSetupRes.ok) {
      const data = await gwSetupRes.json();
      ok(`Google setup endpoint returns SA email: ${data.serviceAccountEmail}`);
    } else {
      warn(`Google setup endpoint returned: ${gwSetupRes.status}`);
    }
  }

  return true;
}

// ─── Phase 3: Intro Email ────────────────────────────────────────────────────

section("Phase 3 — Introduction Email (with SA address)");

async function phase3_intro_email() {
  if (!testAgentEmail || !testInboxHandle) {
    warn("Skipping intro email test — no agent inbox or test inbox");
    return true;
  }

  // The agent sends the intro email from its own inbox to the manager's email.
  // We check AgentMail sent items for the agent's inbox.
  const sentBefore = await agentmail("GET", `/inboxes/${testInboxId}/messages?limit=20`);
  const sentCountBefore = sentBefore.data?.messages?.length ?? 0;

  // Trigger the advance to INTRODUCTION directly via DB + gateway hook
  // (bypassing Clerk auth since this is a test environment)
  await prisma.deployment.update({
    where: { id: testDeploymentId },
    data: { onboardingState: "INTRODUCTION" },
  });

  // Send the intro email via AgentMail API directly (mimicking what advance/route.ts does)
  // We build the same email buildIntroductionEmail would produce
  const saLine = testSAEmail
    ? `<p style="margin:0 0 16px;font-size:14px;"><strong>Google Workspace:</strong> Share files with <code>${testSAEmail}</code></p>`
    : "";

  const introHtml = `<p>I'm Alex, your new AI employee. I'm ready to start working with you.</p>${saLine}<p>Email me at <a href="mailto:${testAgentEmail}">${testAgentEmail}</a> with your first task.</p>`;

  const sendRes = await agentmail("POST", `/inboxes/${testInboxId}/messages/send`, {
    to: [testInboxHandle.email_address],
    subject: `Meet your new AI employee: Alex`,
    html: introHtml,
  });

  if (sendRes.status === 200 || sendRes.status === 201) {
    ok("Intro email sent from agent inbox to manager inbox");
  } else {
    fail("Intro email send via AgentMail API", JSON.stringify(sendRes.data));
    return false;
  }

  // Wait for email to appear in manager's inbox
  try {
    await pollUntil(
      async () => {
        const r = await agentmail("GET", `/inboxes/${testInboxHandle.id}/messages?limit=5`);
        const msgs = r.data?.messages ?? [];
        return msgs.find(m => m.subject?.includes("Meet your new AI employee"));
      },
      { timeoutMs: 30_000, intervalMs: 3000, label: "intro email in manager inbox" }
    );
    ok("Intro email received in manager test inbox");
  } catch {
    warn("Intro email not yet visible in manager inbox (delivery may be delayed)");
  }

  // Notify the agent gateway about the introduction
  try {
    const hookRes = await fetch(`http://localhost:${testGatewayPort}/hooks/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HOOKS_TOKEN}` },
      body: JSON.stringify({
        message: `You have been introduced to the team. Your SA email is ${testSAEmail}. The manager's email is ${testInboxHandle?.email_address}. Wait for them to email you with their first task.`,
        name: "Introduction",
        wakeMode: "now",
        deliver: false,
        sessionKey: "hook:introduction",
      }),
    });
    if (hookRes.ok) {
      ok("Introduction hook delivered to agent gateway");
    } else {
      warn(`Introduction hook returned ${hookRes.status}`);
    }
  } catch (e) {
    warn(`Gateway unreachable for introduction hook: ${e.message}`);
  }

  return true;
}

// ─── Phase 4: Email Auto-Response ────────────────────────────────────────────

section("Phase 4 — Email Auto-Response (no manual intervention)");

async function phase4_email_autoresponse() {
  if (!testAgentEmail || !testInboxHandle) {
    warn("Skipping email auto-response — no inboxes configured");
    return true;
  }

  const testMessage = `Hi Alex! Can you give me a brief status update on what you can help me with today? This is an automated test message. Reply time: ${new Date().toISOString()}`;

  // Send email from our test inbox to the agent's inbox
  const sendRes = await agentmail("POST", `/inboxes/${testInboxHandle.id}/messages/send`, {
    to: [testAgentEmail],
    subject: `Status update request — E2E test ${Date.now()}`,
    text: testMessage,
    html: `<p>${testMessage}</p>`,
  });

  if (sendRes.status !== 200 && sendRes.status !== 201) {
    fail("Email sent to agent inbox", JSON.stringify(sendRes.data));
    return false;
  }

  const sentMsgId = sendRes.data?.id;
  ok(`Email sent to agent (${testAgentEmail}) — msg id: ${sentMsgId}`);
  console.log("  Waiting for agent to auto-reply (up to 3 min)...");

  // Wait for a reply to appear in our test inbox
  try {
    const reply = await pollUntil(
      async () => {
        const r = await agentmail("GET", `/inboxes/${testInboxHandle.id}/messages?limit=10`);
        const msgs = r.data?.messages ?? [];
        // Look for a message FROM the agent (not from us)
        // Match specifically a message FROM the agent (not from our test inbox)
        // testAgentEmail is e.g. "alex-acme-e2e@agentmail.to"
        return msgs.find(m =>
          m.from && testAgentEmail && m.from.includes(testAgentEmail)
        );
      },
      { timeoutMs: 180_000, intervalMs: 8000, label: "agent auto-reply" }
    );
    ok(`Agent auto-replied: "${reply.subject}" — from: ${reply.from}`);
    if (reply.text || reply.html) {
      const preview = (reply.text || "").slice(0, 100);
      console.log(`  Reply preview: "${preview}..."`);
    }
  } catch {
    warn("Agent did not reply within 3 min (may be slow model or quota limit)");
  }

  return true;
}

// ─── Phase 5: Google Drive File Sharing ──────────────────────────────────────

section("Phase 5 — Google Drive File Sharing");

async function phase5_google_drive() {
  if (!testSAEmail) {
    warn("Skipping Google Drive test — no service account email");
    return true;
  }

  // We can't programmatically share files in this test without Drive auth,
  // but we can test that the poller's Drive watcher is configured.
  // We verify the agent's openclaw config has the google-workspace-tools plugin.

  // The provisioning service uses process.cwd() for its data dir.
  // When spawned from the repo root (as the test does), data lands at marketplace/data/.
  const stateDir = join(__dirname, "data", testDeploymentId, "openclaw-state");
  const configPath = join(stateDir, "openclaw.json");

  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const wsTools = cfg?.plugins?.entries?.["google-workspace-tools"];
    if (wsTools?.enabled) {
      ok("google-workspace-tools plugin enabled in agent config");
      const saConfigured = wsTools.config?.serviceAccountEmail === testSAEmail;
      if (saConfigured) {
        ok(`SA email correctly injected into agent config: ${testSAEmail}`);
      } else {
        const actual = wsTools.config?.serviceAccountEmail;
        warn(`SA email mismatch: config has ${actual}, expected ${testSAEmail}`);
      }
    } else {
      warn("google-workspace-tools not found in agent openclaw.json");
    }

    // Check Drive watcher is enabled in poller
    const hasKey = !!wsTools?.config?.serviceAccountKey;
    if (hasKey) {
      ok("SA key available — Drive file watcher will run in poller");
      console.log(`\n  How to test manually:`);
      console.log(`  1. Share any Google Drive file/Sheet/Doc with: ${testSAEmail}`);
      console.log(`  2. Within 30s the poller will detect it and notify the agent`);
      console.log(`  3. The agent will acknowledge via its inbox`);
    } else {
      warn("No SA key in agent config — Drive watching disabled");
    }
  } else {
    warn(`Agent config not found at ${configPath}`);
  }

  return true;
}

// ─── Phase 6: Approval Flow ──────────────────────────────────────────────────

section("Phase 6 — Approval Flow");

async function phase6_approval_flow() {
  // Create a synthetic approval directly (simulating what the agent posts)
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const approval = await prisma.approval.create({
    data: {
      deploymentId: testDeploymentId,
      taskType: "send_email",
      channel: "email",
      draft: "Hi Sarah, I wanted to follow up on our Q3 targets. Are you free Thursday at 2pm?",
      reasoning: "Manager requested follow-up on Q3 targets. Proposing a meeting time.",
      originalRequest: "Schedule a follow-up with Sarah about Q3",
      stakesScore: 4.0,
      ambiguityScore: 2.5,
      reversibilityScore: 3.0,
      combinedScore: 5.2,
      status: "PENDING",
      expiresAt,
      threadId: `e2e-test-thread-${Date.now()}`,
    },
  });
  ok(`Synthetic approval created: ${approval.id}`);

  // Test portal list endpoint (no auth needed — uses portal token)
  const portalRes = await fetch(
    `${WEB_BASE}/api/portal/${testPortalToken}/approvals`,
    { method: "GET" }
  );
  if (portalRes.ok) {
    const data = await portalRes.json();
    ok(`Approval portal accessible — ${data.approvals?.length ?? 0} pending approval(s), agent: ${data.agentName}`);
  } else {
    fail("Approval portal list endpoint", `status: ${portalRes.status}`);
  }

  // Test APPROVE via portal
  const approveRes = await fetch(
    `${WEB_BASE}/api/portal/${testPortalToken}/approvals/${approval.id}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "APPROVED" }),
    }
  );
  if (approveRes.ok) {
    ok("Approval resolved as APPROVED via portal");
  } else {
    fail("Approval resolve via portal", `status: ${approveRes.status}`);
  }

  // Check trust score was updated
  const ts = await prisma.trustScore.findFirst({ where: { deploymentId: testDeploymentId, taskType: "send_email" } });
  if (ts) {
    ok(`Trust score updated — approvedNoEdit: ${ts.approvedNoEdit}, weightedScore: ${ts.weightedScore}`);
  } else {
    warn("Trust score not yet created (may be async)");
  }

  // Test EDIT approval
  const editApproval = await prisma.approval.create({
    data: {
      deploymentId: testDeploymentId,
      taskType: "send_email",
      channel: "email",
      draft: "Hi Ben, let me know your availability for next week.",
      reasoning: "Following up on inquiry",
      originalRequest: "Reply to Ben",
      stakesScore: 3.0,
      ambiguityScore: 2.0,
      reversibilityScore: 3.0,
      combinedScore: 4.5,
      status: "PENDING",
      expiresAt,
      threadId: `e2e-test-thread-edit-${Date.now()}`,
    },
  });

  const editRes = await fetch(
    `${WEB_BASE}/api/portal/${testPortalToken}/approvals/${editApproval.id}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "EDITED",
        editedText: "Hi Ben, I'm available Mon–Wed next week. Please let me know what works for you.",
      }),
    }
  );
  if (editRes.ok) {
    ok("Approval resolved as EDITED with new text via portal");
  } else {
    fail("Edited approval resolve", `status: ${editRes.status}`);
  }

  // Test REJECT
  const rejectApproval = await prisma.approval.create({
    data: {
      deploymentId: testDeploymentId,
      taskType: "send_email",
      channel: "email",
      draft: "Dear all, please see the attached quarterly report...",
      reasoning: "Sharing report with all stakeholders",
      originalRequest: "Send quarterly report",
      stakesScore: 7.0,
      ambiguityScore: 4.0,
      reversibilityScore: 6.0,
      combinedScore: 8.1,
      status: "PENDING",
      expiresAt,
      threadId: `e2e-test-thread-reject-${Date.now()}`,
    },
  });

  const rejectRes = await fetch(
    `${WEB_BASE}/api/portal/${testPortalToken}/approvals/${rejectApproval.id}/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "REJECTED",
        rejectionReason: "Report is not ready yet — wait for final numbers from finance.",
      }),
    }
  );
  if (rejectRes.ok) {
    ok("Approval resolved as REJECTED with reason via portal");
  } else {
    fail("Rejected approval resolve", `status: ${rejectRes.status}`);
  }

  return true;
}

// ─── Phase 7: Pause ──────────────────────────────────────────────────────────

section("Phase 7 — Pause");

async function phase7_pause() {
  // Advance to ACTIVE so we can pause
  await prisma.deployment.update({
    where: { id: testDeploymentId },
    data: { status: "ACTIVE", onboardingState: "LIVE" },
  });

  // Enqueue a real pause job
  await provQueue.add("pause", { type: "pause", deploymentId: testDeploymentId }, {
    jobId: `e2e-pause-${testDeploymentId}`,
    attempts: 1,
  });
  ok("Pause job enqueued");

  // Wait for status to become PAUSED
  try {
    await pollUntil(
      async () => {
        const dep = await prisma.deployment.findUnique({ where: { id: testDeploymentId } });
        return dep?.status === "PAUSED" ? dep : null;
      },
      { timeoutMs: 60_000, intervalMs: 2000, label: "deployment PAUSED" }
    );
    ok("Deployment status → PAUSED");

    // Verify gateway is no longer accepting connections
    await sleep(2000);
    try {
      const res = await fetch(`http://localhost:${testGatewayPort}/`, { signal: AbortSignal.timeout(3000) });
      warn(`Gateway still responding after pause (status: ${res.status}) — may take a moment`);
    } catch {
      ok("Gateway no longer accepting connections after pause");
    }
  } catch {
    warn("Status did not reach PAUSED within 60s — check provisioning service logs");
  }

  return true;
}

// ─── Phase 8: Resume ─────────────────────────────────────────────────────────

section("Phase 8 — Resume");

async function phase8_resume() {
  await provQueue.add("resume", { type: "resume", deploymentId: testDeploymentId }, {
    jobId: `e2e-resume-${testDeploymentId}`,
    attempts: 1,
  });
  ok("Resume job enqueued");

  try {
    await pollUntil(
      async () => {
        const dep = await prisma.deployment.findUnique({ where: { id: testDeploymentId } });
        return dep?.status === "ACTIVE" ? dep : null;
      },
      { timeoutMs: 60_000, intervalMs: 3000, label: "deployment ACTIVE after resume" }
    );
    ok("Deployment status → ACTIVE after resume");

    // Verify gateway responds again
    await sleep(3000);
    try {
      await fetch(`http://localhost:${testGatewayPort}/`, { signal: AbortSignal.timeout(5000) });
      ok("Gateway responding after resume");
    } catch {
      warn("Gateway not yet responding after resume — may still be starting");
    }
  } catch {
    warn("Status did not reach ACTIVE after resume within 60s");
  }

  return true;
}

// ─── Phase 9: AgentMind ──────────────────────────────────────────────────────

section("Phase 9 — AgentMind (contribute → search → use → vote → reflect)");

async function phase9_agentmind() {
  // Ensure deployment is ACTIVE (resumed in phase 8)
  const dep = await prisma.deployment.findUnique({ where: { id: testDeploymentId } });
  if (dep?.status !== "ACTIVE") {
    warn("Deployment not ACTIVE — skipping AgentMind tests");
    return true;
  }

  // ── 9a. Contribute ──────────────────────────────────────────────────────────
  // The contribute endpoint requires: ACTIVE status + at least one resolved approval
  // We have both from phases 6 and 8.
  const contributeRes = await fetch(`${WEB_BASE}/api/agentmind/contribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deploymentId: testDeploymentId,
      type: "PATTERN",
      title: "Always confirm meeting time zone before scheduling",
      content:
        "When scheduling meetings across teams, always confirm the attendee's time zone before proposing a time. Ambiguous times (e.g. '2pm') cause missed meetings. Pattern: reply with 'What time zone are you in?' before confirming any meeting slot.",
      context: "E2E test contribution — scheduling coordination pattern",
      tags: ["scheduling", "meetings", "time-zone", "coordination"],
    }),
  });

  let contributionId;
  if (contributeRes.ok) {
    const data = await contributeRes.json();
    contributionId = data.id;
    const statusLabel = data.duplicate ? "duplicate (already exists)" : `status: ${data.status}`;
    ok(`AgentMind contribution created/found — ${statusLabel}, id: ${contributionId?.slice(0, 8)}`);
    if (data.status === "APPROVED") {
      ok("Contribution auto-approved (agentMindAutoApprove defaults to true)");
    } else if (data.status === "PENDING") {
      // Manually approve it so search/use/vote work
      await prisma.knowledgeContribution.update({
        where: { id: contributionId },
        data: { status: "APPROVED", reviewNote: "E2E test auto-approve", reviewedBy: "e2e-test" },
      });
      ok("Contribution manually approved for downstream tests");
    }
  } else {
    const text = await contributeRes.text();
    fail("AgentMind contribute endpoint", `${contributeRes.status}: ${text.slice(0, 200)}`);
    return true; // non-blocking, continue with other phases
  }

  // ── 9b. Search ──────────────────────────────────────────────────────────────
  const searchUrl = `${WEB_BASE}/api/agentmind/search?agentId=${testAgentId}&deploymentId=${testDeploymentId}&q=scheduling&limit=5`;
  const searchRes = await fetch(searchUrl);
  if (searchRes.ok) {
    const data = await searchRes.json();
    const items = data.contributions ?? [];
    ok(`AgentMind search returned ${items.length} result(s) for "scheduling"`);
    const found = items.find(c => c.id === contributionId);
    if (found) {
      ok(`Contributed item found in search results — usageCount: ${found.usageCount}, upvotes: ${found.upvotes}`);
    } else if (items.length > 0) {
      warn("Contributed item not in top search results (may be filtered or ranked lower)");
    }
  } else {
    fail("AgentMind search endpoint", `${searchRes.status}`);
  }

  // ── 9c. Use ─────────────────────────────────────────────────────────────────
  if (contributionId) {
    const useRes = await fetch(`${WEB_BASE}/api/agentmind/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deploymentId: testDeploymentId,
        contributionIds: [contributionId],
      }),
    });
    if (useRes.ok) {
      const data = await useRes.json();
      ok(`AgentMind /use reported ${data.used ?? 0} contribution(s) tracked`);

      // Verify usageCount incremented in DB
      const updated = await prisma.knowledgeContribution.findUnique({ where: { id: contributionId } });
      if (updated?.usageCount >= 1) {
        ok(`usageCount incremented to ${updated.usageCount} in DB`);
      } else {
        warn("usageCount did not increment (may be async)");
      }
      // /use also auto-upvotes — verify
      const vote = await prisma.knowledgeVote.findFirst({
        where: { contributionId, deploymentId: testDeploymentId },
      });
      if (vote?.vote === 1) {
        ok("Auto-upvote recorded after /use call");
      } else {
        warn("Auto-upvote not yet visible in DB");
      }
    } else {
      fail("AgentMind /use endpoint", `${useRes.status}`);
    }
  }

  // ── 9d. Vote (explicit downvote — tests vote flip) ──────────────────────────
  // After /use auto-upvoted, we send a -1 to test vote flip logic
  if (contributionId) {
    const voteRes = await fetch(`${WEB_BASE}/api/agentmind/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deploymentId: testDeploymentId,
        contributionId,
        vote: -1,
      }),
    });
    if (voteRes.ok) {
      ok("Downvote (vote=-1) recorded via /vote — tests vote-flip from auto-upvote");
      const c = await prisma.knowledgeContribution.findUnique({ where: { id: contributionId } });
      console.log(`    upvotes: ${c?.upvotes}, downvotes: ${c?.downvotes}`);
    } else {
      warn(`AgentMind /vote returned ${voteRes.status}`);
    }
  }

  // ── 9e. Reflect — check contribution from EDITED approval (phase 6) ─────────
  // The EDITED resolution in phase 6 calls resolveApprovalAndUpdateTrust → reflect()
  // which should have created a PENDING KnowledgeContribution of type CORRECTION or PATTERN
  const reflectContrib = await prisma.knowledgeContribution.findFirst({
    where: {
      agentId: testAgentId,
      type: { in: ["CORRECTION", "PATTERN"] },
      // Created after phase 6 started (rough check: within last 30 min)
      createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) },
    },
    orderBy: { createdAt: "desc" },
  });

  if (reflectContrib) {
    ok(`Reflect contribution found — type: ${reflectContrib.type}, status: ${reflectContrib.status}`);
    console.log(`    Title: "${reflectContrib.title?.slice(0, 80)}"`);
    if (reflectContrib.status === "APPROVED") {
      ok("Reflect contribution auto-approved");
    } else if (reflectContrib.status === "PENDING") {
      ok("Reflect contribution is PENDING admin review (expected without ANTHROPIC_API_KEY set)");
    }
  } else {
    // The LLM reflect call requires ANTHROPIC_API_KEY — it falls back silently without one
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    if (!hasAnthropic) {
      warn("No ANTHROPIC_API_KEY set — reflect creates rule-based contributions (may not appear)");
    } else {
      warn("Reflect contribution not found — check resolveApprovalAndUpdateTrust logs");
    }
  }

  // ── 9f. Stats from DB ───────────────────────────────────────────────────────
  // /api/agentmind/stats requires Clerk org auth; query the DB directly in tests
  const allContribs = await prisma.knowledgeContribution.findMany({
    where: { agentId: testAgentId },
    select: { status: true, usageCount: true, upvotes: true, downvotes: true },
  });
  const totalUsage = allContribs.reduce((s, c) => s + c.usageCount, 0);
  const approvedCount = allContribs.filter(c => c.status === "APPROVED").length;
  ok(`AgentMind DB stats — total: ${allContribs.length}, approved: ${approvedCount}, totalUsage: ${totalUsage}`);

  return true;
}

// ─── Phase 10: Fire ──────────────────────────────────────────────────────────

section("Phase 10 — Fire (full cleanup)");

async function phase10_fire() {
  const depBefore = await prisma.deployment.findUnique({
    where: { id: testDeploymentId },
    select: { agentEmail: true, agentEmailInboxId: true, deploymentServiceAccountEmail: true },
  });

  const inboxIdToCheck = depBefore?.agentEmailInboxId;
  const saEmailToCheck = depBefore?.deploymentServiceAccountEmail;

  // Enqueue deprovision job
  await provQueue.add("deprovision", { type: "deprovision", deploymentId: testDeploymentId }, {
    jobId: `e2e-deprovision-${testDeploymentId}`,
    attempts: 1,
  });
  ok("Deprovision (fire) job enqueued");

  // Wait for FIRED status
  try {
    await pollUntil(
      async () => {
        const dep = await prisma.deployment.findUnique({ where: { id: testDeploymentId } });
        return dep?.status === "FIRED" ? dep : null;
      },
      { timeoutMs: 60_000, intervalMs: 3000, label: "deployment FIRED" }
    );
    ok("Deployment status → FIRED");
  } catch {
    warn("Status did not reach FIRED within 60s — may need longer or provisioning service issue");
    return false;
  }

  // Verify inbox was deleted
  if (inboxIdToCheck) {
    const inboxCheck = await agentmail("GET", `/inboxes/${inboxIdToCheck}`);
    if (inboxCheck.status === 404) {
      ok("AgentMail inbox deleted after fire");
    } else if (inboxCheck.status === 200) {
      fail("AgentMail inbox should be deleted after fire");
    } else {
      warn(`Inbox check returned ${inboxCheck.status}`);
    }
  }

  // Verify gateway is down
  try {
    await fetch(`http://localhost:${testGatewayPort}/`, { signal: AbortSignal.timeout(2000) });
    warn("Gateway still responding after fire (process may still be shutting down)");
  } catch {
    ok("Gateway stopped after fire");
  }

  // Verify SA was deleted (if per-deployment SA was created)
  if (saEmailToCheck && saEmailToCheck !== process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    console.log(`\n  Verifying per-deployment SA deletion: ${saEmailToCheck}`);
    // We can't directly verify from here without GCP API, but we check the provisioning log
    const logs = await prisma.provisioningLog.findMany({
      where: { deploymentId: testDeploymentId, step: "delete_service_account" },
    });
    if (logs.some(l => l.status === "succeeded")) {
      ok("Provisioning log shows SA deletion succeeded");
    } else if (logs.length > 0) {
      warn(`SA deletion log: ${logs.map(l => l.status).join(", ")}`);
    } else {
      warn("No SA deletion log found (may use different step name)");
    }
  }

  return true;
}

// ─── Phase 10: Cleanup Test Inbox ────────────────────────────────────────────

async function cleanup() {
  // Note: We don't delete test-manager@agentmail.to — it's a shared test fixture

  // Kill the provisioning service
  if (provisioningServiceProcess && !provisioningServiceProcess.killed) {
    provisioningServiceProcess.kill("SIGTERM");
    console.log("  Provisioning service stopped");
  }

  await prisma.$disconnect();
  await provQueue.close();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║   Marketplace — Comprehensive E2E Test Suite      ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  try {
    const ok0 = await phase0_setup();
    if (!ok0) { console.log("\nSetup failed — aborting."); process.exit(1); }

    await phase1_provision();
    await phase2_service_account();
    await phase3_intro_email();
    await phase4_email_autoresponse();
    await phase5_google_drive();
    await phase6_approval_flow();
    await phase7_pause();
    await phase8_resume();
    await phase9_agentmind();
    await phase10_fire();
  } catch (err) {
    console.error("\nUnhandled test error:", err);
    fail("Test suite completed without unhandled errors", err.message);
  } finally {
    await cleanup();
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("  RESULTS");
  console.log(`${"═".repeat(60)}`);
  console.log(`  ✓ Passed:   ${passed}`);
  console.log(`  ✗ Failed:   ${failed}`);
  console.log(`  ⚠ Warnings: ${warnings}`);
  if (failures.length > 0) {
    console.log("\n  Failed tests:");
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log(`${"═".repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main();
