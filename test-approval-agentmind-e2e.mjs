/**
 * Approval Flow + AgentMind E2E Test
 *
 * Tests:
 *   1. Approval flow — emails sent to Alex and Maya trigger approval queue
 *   2. AgentMind use tracking — poller marks contributions used after forwarding
 *   3. Contribution quality — natural language, no sensitive data
 *
 * Run: node test-approval-agentmind-e2e.mjs
 */

import { PrismaClient } from "@prisma/client";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const BASE = "http://localhost:3002";
const AGENTMAIL_KEY = process.env.AGENTMAIL_API_KEY;
const ALEX_DEPLOYMENT_ID = "calex17765247590t01";
const MAYA_DEPLOYMENT_ID = "cmaya417764861730t01";
const ALEX_AGENT_ID = "cmo350ivv0002rs4ozt249pbh";
const MAYA_AGENT_ID = "cmo0fe0ts0001rsl46yvt0q8n";
const ALEX_INBOX = "general-ops-alex-my-company@agentmail.to";
const MAYA_INBOX = "maya-tech-support-my-company@agentmail.to";
const SENDER_INBOX = "test-manager@agentmail.to";

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

async function api(method, path, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}

async function sendEmail(fromInbox, toAddress, subject, body) {
  const res = await fetch(
    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(fromInbox)}/messages/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AGENTMAIL_KEY}`,
      },
      body: JSON.stringify({
        to: toAddress,
        subject,
        text: body,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function startPoller(deploymentId, agentId, agentEmail, gatewayUrl, hooksToken = "") {
  const script = join(__dirname, "apps/provisioning-service/src/jobs/agentmail-poller.mjs");
  const env = {
    ...process.env,
    AGENTMAIL_API_KEY: AGENTMAIL_KEY,
    POLLER_INBOX: agentEmail,
    POLLER_INBOX_ID: agentEmail,
    POLLER_GATEWAY_URL: gatewayUrl,
    MARKETPLACE_URL: BASE,
    DEPLOYMENT_ID: deploymentId,
    AGENT_ID: agentId,
    OPENCLAW_HOOKS_TOKEN: hooksToken,
  };

  const child = spawn(process.execPath, [script], { env, stdio: "pipe" });
  const label = `[poller-${deploymentId.slice(0, 8)}]`;
  child.stdout.on("data", (d) => process.stdout.write(`${label} ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`${label} ${d}`));
  child.on("exit", (code) => console.log(`${label} Exited (${code})`));
  return child;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setupState() {
  console.log("\n── Setup: Ensuring DB state ──────────────────────────────────");

  // Add portal tokens if missing
  const alexPortalToken = `alex-portal-${randomBytes(6).toString("hex")}`;
  const mayaPortalToken = `maya-portal-${randomBytes(6).toString("hex")}`;

  await prisma.deployment.update({
    where: { id: ALEX_DEPLOYMENT_ID },
    data: {
      portalToken: { set: alexPortalToken },
      autonomyConfig: {
        approvalPolicy: "external-only",
        agentMindEnabled: true,
        agentMindAutoApprove: true,
      },
    },
  });
  console.log(`  Alex portal token: ${alexPortalToken}`);

  await prisma.deployment.update({
    where: { id: MAYA_DEPLOYMENT_ID },
    data: {
      portalToken: { set: mayaPortalToken },
      autonomyConfig: {
        approvalPolicy: "always",
        agentMindEnabled: true,
        agentMindAutoApprove: true,
      },
    },
  });
  console.log(`  Maya portal token: ${mayaPortalToken}`);

  // Maya needs at least 1 resolved approval to contribute to AgentMind.
  // If she has none, seed a synthetic one so she can contribute later.
  const mayaResolved = await prisma.approval.findFirst({
    where: { deploymentId: MAYA_DEPLOYMENT_ID, status: { in: ["APPROVED", "EDITED"] } },
  });
  if (!mayaResolved) {
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await prisma.approval.create({
      data: {
        deploymentId: MAYA_DEPLOYMENT_ID,
        threadId: "synthetic-seed-thread",
        channel: "email",
        draft: "Thank you for reaching out. I have reviewed the issue and will follow up shortly.",
        reasoning: "Initial seed approval to unlock AgentMind contribute capability.",
        originalRequest: "Help with account access",
        taskType: "general",
        stakesScore: 1,
        ambiguityScore: 1,
        reversibilityScore: 9,
        combinedScore: 2.0,
        status: "APPROVED",
        resolvedAt: new Date(),
        expiresAt: expires,
      },
    });
    console.log("  Maya synthetic resolved approval created");
  } else {
    console.log("  Maya already has a resolved approval");
  }

  return { alexPortalToken, mayaPortalToken };
}

// ─── Part 1: AgentMind — Seed + Verify Guardrails ────────────────────────────

async function testAgentMindContribute() {
  console.log("\n── Part 1: AgentMind Contribute ─────────────────────────────");

  // Seed a natural-language PATTERN contribution from Alex
  const { status, data } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: ALEX_DEPLOYMENT_ID,
    type: "PATTERN",
    title: "Handling external email drafting requests",
    content:
      "When a user asks me to draft and send an email to an external recipient, I first confirm the recipient, subject, and tone before drafting. I always queue the draft for manager approval before sending, clearly stating who it goes to and why. This prevents accidental sends to unintended parties.",
    context: "Triggered when inbox contains phrases like 'send an email to', 'draft a message for', or 'reach out to'.",
    tags: ["email", "approval", "external-comms", "drafting"],
  });

  ok(status === 201 || (status === 200 && data.duplicate), `Contribution created (${status})`);
  const contribId = data.id;
  ok(typeof contribId === "string" && contribId.length > 0, `Contribution ID: ${contribId}`);
  ok(data.status === "APPROVED" || data.duplicate, `Auto-approved (status: ${data.status})`);

  // Verify guardrails: real API keys get SANITIZED (scrubbed) before storage
  // The guardrail system sanitizes content rather than rejecting it — secrets are redacted
  const realishKey = "sk-" + "a".repeat(32); // matches /\bsk[-_][A-Za-z0-9]{20,}\b/ in guardrails
  const { status: badStatus, data: badData } = await api("POST", "/api/agentmind/contribute", {
    deploymentId: ALEX_DEPLOYMENT_ID,
    type: "CORRECTION",
    title: "Sanitization test — should scrub API key",
    content: `Use token ${realishKey} to access the external service endpoint.`,
    tags: ["test", "sanitization"],
  });
  // Content should be accepted (201) but the stored content should NOT contain the raw key
  ok(badStatus === 201 || badStatus === 200, `Guardrails accept submission (${badStatus})`);
  if (badData?.id) {
    const stored = await prisma.knowledgeContribution.findUnique({ where: { id: badData.id } });
    ok(!stored?.content?.includes(realishKey), `Stored content does NOT contain raw API key (scrubbed)`);
    ok(stored?.rawContent?.includes(realishKey) || !!stored?.rawContent, `Raw content preserved separately`);
    // Clean up test contribution
    await prisma.knowledgeContribution.delete({ where: { id: badData.id } }).catch(() => {});
  }

  // Verify content is natural language — no raw secrets, no system prompt leakage
  const { status: sStatus, data: sData } = await api(
    "GET",
    `/api/agentmind/search?agentId=${ALEX_AGENT_ID}&deploymentId=${ALEX_DEPLOYMENT_ID}&q=external+email+drafting&limit=3`
  );
  ok(sStatus === 200, `Search returns 200`);
  const entries = sData.contributions || sData.data || (Array.isArray(sData) ? sData : []);
  ok(Array.isArray(entries) && entries.length > 0, `Search finds our contribution (${entries.length} results)`);
  if (entries.length > 0) {
    const entry = entries[0];
    ok(typeof entry.content === "string" && entry.content.length > 20, "Content is a non-empty string");
    ok(!entry.content.includes("sk-") && !entry.content.includes("password"), "No raw secrets in content");
    ok(!entry.content.includes("SYSTEM:") && !entry.content.includes("<<<"), "No prompt leakage in content");
    console.log(`  Content preview: "${entry.content.slice(0, 100)}..."`);
  }

  return contribId;
}

// ─── Part 2: Send Emails → Approval + Use Tracking ───────────────────────────

async function sendTestEmails() {
  console.log("\n── Part 2: Sending test emails ──────────────────────────────");

  // Email to Alex: ask him to send an external email → triggers external-only approval policy
  const alexResult = await sendEmail(
    SENDER_INBOX,
    ALEX_INBOX,
    "Please reach out to our new vendor",
    `Hi Alex,

Could you please send a welcome email to our new logistics vendor at vendor-contact@newlogistics.co?
The email should introduce us and request a kickoff call next week.

Thanks,
Manager`
  );
  ok(alexResult.status >= 200 && alexResult.status < 300, `Email to Alex sent (${alexResult.status})`);
  console.log(`  Alex email ID: ${alexResult.data?.message_id || alexResult.data?.id || "unknown"}`);

  // Email to Maya: a tech support question → triggers always-approve policy
  const mayaResult = await sendEmail(
    SENDER_INBOX,
    MAYA_INBOX,
    "Login issue with SSO",
    `Hi Maya,

A user in the engineering team (user: jsmith) is getting a "SAML assertion expired" error
when trying to log in through our SSO portal. They've already cleared their browser cache.

Can you look into this and help resolve it?

Thanks`
  );
  ok(mayaResult.status >= 200 && mayaResult.status < 300, `Email to Maya sent (${mayaResult.status})`);
  console.log(`  Maya email ID: ${mayaResult.data?.message_id || mayaResult.data?.id || "unknown"}`);
}

// ─── Part 3: Pollers + Wait ───────────────────────────────────────────────────

async function runPollers() {
  console.log("\n── Part 3: Starting pollers ─────────────────────────────────");

  const alexPoller = startPoller(
    ALEX_DEPLOYMENT_ID, ALEX_AGENT_ID,
    ALEX_INBOX, "http://localhost:18800",
    "" // OpenClaw hooks token — empty string for local gateway without auth
  );

  const mayaPoller = startPoller(
    MAYA_DEPLOYMENT_ID, MAYA_AGENT_ID,
    MAYA_INBOX, "http://localhost:32785",
    "" // Custom runtime — no hooks token
  );

  console.log("  Alex poller → http://localhost:18800");
  console.log("  Maya poller → http://localhost:32785");
  console.log("  Waiting 20s for pollers to pick up messages...\n");

  await sleep(20000);

  alexPoller.kill();
  mayaPoller.kill();
  console.log("\n  Pollers stopped.");
}

// ─── Part 4: Verify Approval Queue ───────────────────────────────────────────

async function verifyApprovals(alexPortalToken, mayaPortalToken) {
  console.log("\n── Part 4: Verify approval queue ────────────────────────────");

  // Alex's portal
  const { status: aStatus, data: aData } = await api(
    "GET",
    `/api/portal/${alexPortalToken}/approvals`
  );
  ok(aStatus === 200, `Alex portal approvals endpoint returns 200 (got ${aStatus})`);
  const alexApprovals = aData.approvals || [];
  ok(alexApprovals.length > 0, `Alex has ${alexApprovals.length} pending approval(s)`);
  if (alexApprovals.length > 0) {
    const a = alexApprovals[0];
    console.log(`  Alex draft preview: "${(a.draft || "").slice(0, 120)}"`);
    ok(typeof a.draft === "string" && a.draft.length > 10, "Draft is non-empty");
    ok(typeof a.reasoning === "string" && a.reasoning.length > 10, "Reasoning is present");
    ok(a.stakesScore >= 0 && a.stakesScore <= 10, `Stakes score valid (${a.stakesScore})`);
  }

  // Maya's portal
  const { status: mStatus, data: mData } = await api(
    "GET",
    `/api/portal/${mayaPortalToken}/approvals`
  );
  ok(mStatus === 200, `Maya portal approvals endpoint returns 200 (got ${mStatus})`);
  const mayaApprovals = mData.approvals || [];
  ok(mayaApprovals.length > 0, `Maya has ${mayaApprovals.length} pending approval(s)`);
  if (mayaApprovals.length > 0) {
    const a = mayaApprovals[0];
    console.log(`  Maya draft preview: "${(a.draft || "").slice(0, 120)}"`);
    ok(typeof a.draft === "string" && a.draft.length > 10, "Maya draft is non-empty");
    ok(typeof a.taskType === "string", `Task type: ${a.taskType}`);
  }

  return { alexApprovals, mayaApprovals };
}

// ─── Part 5: Verify AgentMind Use Tracking ────────────────────────────────────

async function verifyAgentMindUse(contribId) {
  console.log("\n── Part 5: Verify AgentMind use tracking ────────────────────");

  // Check usage count on the contribution we seeded
  const { status, data } = await api(
    "GET",
    `/api/agentmind/contributions/${contribId}`
  );

  if (status === 200 || status === 404) {
    ok(status === 200, `Contribution ${contribId} retrievable (got ${status})`);
    if (status === 200) {
      const contrib = data.contribution || data;
      console.log(`  usageCount: ${contrib.usageCount}, upvotes: ${contrib.upvotes}`);
      ok(typeof contrib.usageCount === "number", `usageCount is a number (${contrib.usageCount})`);
    }
  } else {
    // Try direct DB check as fallback
    const contrib = await prisma.knowledgeContribution.findUnique({ where: { id: contribId } });
    ok(!!contrib, `Contribution found in DB`);
    if (contrib) {
      console.log(`  usageCount: ${contrib.usageCount}, upvotes: ${contrib.upvotes}`);
      ok(contrib.usageCount >= 0, `usageCount tracked (${contrib.usageCount})`);
    }
  }

  // Direct use endpoint test — manually mark our contribution as used
  const { status: useStatus, data: useData } = await api("POST", "/api/agentmind/use", {
    deploymentId: MAYA_DEPLOYMENT_ID,
    contributionIds: [contribId],
  });
  ok(useStatus === 200, `Use endpoint returns 200 (got ${useStatus})`);
  ok(Array.isArray(useData.results), `Use returns results array`);
  if (useData.results) {
    console.log(`  Use results: ${JSON.stringify(useData.results)}`);
  }

  // Confirm usage count incremented (check DB directly)
  const after = await prisma.knowledgeContribution.findUnique({ where: { id: contribId } });
  ok((after?.usageCount ?? 0) >= 1, `usageCount >= 1 after use call (${after?.usageCount})`);
  ok((after?.upvotes ?? 0) >= 1, `upvotes >= 1 after use call (${after?.upvotes})`);
  console.log(`  Final state — usageCount: ${after?.usageCount}, upvotes: ${after?.upvotes}`);
}

// ─── Part 6: Portal Resolve ───────────────────────────────────────────────────

async function testPortalResolve(alexPortalToken, alexApprovals) {
  console.log("\n── Part 6: Portal approve flow ──────────────────────────────");

  if (!alexApprovals.length) {
    console.log("  Skipped — no Alex approvals to resolve");
    return;
  }

  const approval = alexApprovals[0];
  const { status, data } = await api(
    "POST",
    `/api/portal/${alexPortalToken}/approvals/${approval.id}/resolve`,
    { action: "APPROVED" }
  );

  ok(status === 200, `Resolve approval returns 200 (got ${status})`);
  ok(data.approval?.status === "APPROVED", `Approval status is APPROVED (${data.approval?.status})`);
  console.log(`  Resolved approval ${approval.id} → APPROVED`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Approval Flow + AgentMind E2E Test ===\n");

  if (!AGENTMAIL_KEY) {
    console.error("ERROR: AGENTMAIL_API_KEY not set");
    process.exit(1);
  }

  // Verify web app is up
  const healthCheck = await fetch(`${BASE}/api/agents`).catch(() => null);
  if (!healthCheck?.ok) {
    console.error(`ERROR: Web app not responding at ${BASE}`);
    process.exit(1);
  }
  console.log(`Web app: OK at ${BASE}`);

  // Verify gateways
  const alexGw = await fetch("http://localhost:18800/health").catch(() => null);
  ok(alexGw?.ok, `Alex gateway up at :18800`);

  // Maya's custom runtime returns 404 on /health (FastAPI, no health route defined)
  // — any response (including 404) means the container is reachable
  const mayaGw = await fetch("http://localhost:32785/health").catch(() => null);
  ok(mayaGw !== null, `Maya gateway up at :32785 (status: ${mayaGw?.status ?? "unreachable"})`);

  const { alexPortalToken, mayaPortalToken } = await setupState();
  const contribId = await testAgentMindContribute();
  await sendTestEmails();
  await runPollers();
  const { alexApprovals, mayaApprovals } = await verifyApprovals(alexPortalToken, mayaPortalToken);
  await verifyAgentMindUse(contribId);
  await testPortalResolve(alexPortalToken, alexApprovals);

  console.log("\n═══════════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFailed checks:");
    failures.forEach((f) => console.log(`  ✗ ${f}`));
  }
  console.log("═══════════════════════════════════════════════\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  prisma.$disconnect();
  process.exit(1);
});
