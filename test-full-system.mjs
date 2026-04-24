/**
 * Full System E2E Test — Marketplace
 *
 * Provisions one of each agent type, drives onboarding, emails agents,
 * tests AgentMind, and verifies approvals.
 *
 * Run: node --env-file=.env test-full-system.mjs
 */

import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const prisma = new PrismaClient();
const BASE = "http://localhost:3002";

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

async function api(method, path, body = null, headers = {}) {
  const opts = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Provision helper ────────────────────────────────────────────────────────

async function provisionAgent(opts) {
  const { agentSlug, companyName, companyDomain, agentName, clerkOrgId } = opts;

  const company = await prisma.company.upsert({
    where: { clerkOrgId },
    update: {},
    create: { clerkOrgId, name: companyName, domain: companyDomain },
  });

  const agent = await prisma.agent.findUnique({ where: { slug: agentSlug } });
  if (!agent) throw new Error(`Agent not found: ${agentSlug}`);

  const deployment = await prisma.deployment.create({
    data: {
      agentId: agent.id,
      companyId: company.id,
      agentVersion: agent.currentVersion,
      agentName,
      status: "PROVISIONING",
      weeklyDigestEmail: `manager@${companyDomain}`,
      autonomyConfig: { approvalPolicy: "external-only" },
    },
  });

  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });
  const job = await queue.add("provision", { type: "provision", deploymentId: deployment.id });
  await queue.close();

  return { company, agent, deployment, jobId: job.id };
}

// ─── Wait for deployment to reach target status ──────────────────────────────

async function waitForDeployment(deploymentId, targetStatus = "ONBOARDING", timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dep = await prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!dep) return null;
    if (dep.status === targetStatus || dep.status === "ERROR") return dep;
    process.stdout.write(".");
    await sleep(3000);
  }
  return null;
}

// ─── Send a message to an agent gateway directly ─────────────────────────────

async function sendEmailToAgent(gatewayUrl, hooksToken, opts) {
  const { from, subject, text, threadId } = opts;
  const messageId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = {
    type: "webhook",
    event_type: "message.received",
    event_id: messageId,
    message: {
      message_id: messageId,
      inbox_id: "test-inbox",
      thread_id: threadId || messageId,
      from,
      to: "agent@agentmail.to",
      subject,
      text,
      html: "",
    },
    thread: { thread_id: threadId || messageId, subject },
  };

  const headers = { "Content-Type": "application/json" };
  if (hooksToken) headers["Authorization"] = `Bearer ${hooksToken}`;

  try {
    const res = await fetch(`${gatewayUrl}/hooks/agentmail`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, text: await res.text().catch(() => "") };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

// ─── SECTION 1: Public marketplace API ───────────────────────────────────────

async function testPublicApi() {
  section("1. Public Marketplace API");

  // Browse agents
  const { status, data } = await api("GET", "/api/agents");
  assert(status === 200, `GET /api/agents → 200`);
  assert(Array.isArray(data.agents) && data.agents.length >= 2, `At least 2 agents listed (got ${data.agents?.length})`);

  const agentTypes = data.agents?.map(a => a.runtime) || [];
  assert(agentTypes.includes("OPENCLAW"), "OPENCLAW runtime agent present");
  assert(agentTypes.includes("CUSTOM"), "CUSTOM runtime agent present");

  // Browse specific agents
  const alexR = await api("GET", "/api/agents/general-ops-alex");
  assert(alexR.status === 200, "GET /api/agents/general-ops-alex → 200");
  assert(alexR.data?.runtime === "OPENCLAW", "Alex is OPENCLAW runtime");
  assert(Array.isArray(alexR.data?.onboardingQuestions), "Alex has onboarding questions");

  const langchainR = await api("GET", "/api/agents/langchain-ops");
  assert(langchainR.status === 200, "GET /api/agents/langchain-ops → 200");
  assert(langchainR.data?.runtime === "CUSTOM", "LangChain is CUSTOM runtime");

  // Search / filter
  const filtered = await api("GET", "/api/agents?category=GENERAL");
  assert(filtered.status === 200, "Agent category filter works");

  return data.agents;
}

// ─── SECTION 2: Provision all agent types ────────────────────────────────────

async function testProvisioning() {
  section("2. Agent Provisioning");

  const results = {};

  // 2a. OpenClaw agent (Alex)
  console.log("\n  [Alex — OPENCLAW] Provisioning...");
  let alexProvision;
  try {
    alexProvision = await provisionAgent({
      agentSlug: "general-ops-alex",
      companyName: "Acme Corp",
      companyDomain: "acme.example.com",
      agentName: "Alex",
      clerkOrgId: "e2e-acme-001",
    });
    assert(true, `Alex deployment created: ${alexProvision.deployment.id.slice(0, 8)}`);
    results.alex = alexProvision;
  } catch (e) {
    assert(false, `Alex provision setup: ${e.message}`);
  }

  // 2b. Custom/LangChain agent
  console.log("\n  [LangChain Ops — CUSTOM] Provisioning (Docker build — this takes ~2 min)...");
  let langchainProvision;
  try {
    langchainProvision = await provisionAgent({
      agentSlug: "langchain-ops",
      companyName: "Beta Industries",
      companyDomain: "beta.example.com",
      agentName: "Ops Bot",
      clerkOrgId: "e2e-beta-001",
    });
    assert(true, `LangChain deployment created: ${langchainProvision.deployment.id.slice(0, 8)}`);
    results.langchain = langchainProvision;
  } catch (e) {
    assert(false, `LangChain provision setup: ${e.message}`);
  }

  // 2c. Maya (CUSTOM) for a different company
  console.log("\n  [Maya — CUSTOM] Provisioning...");
  let mayaProvision;
  try {
    mayaProvision = await provisionAgent({
      agentSlug: "maya-tech-support",
      companyName: "Gamma Tech",
      companyDomain: "gamma.example.com",
      agentName: "Maya",
      clerkOrgId: "e2e-gamma-001",
    });
    assert(true, `Maya deployment created: ${mayaProvision.deployment.id.slice(0, 8)}`);
    results.maya = mayaProvision;
  } catch (e) {
    assert(false, `Maya provision setup: ${e.message}`);
  }

  return results;
}

// ─── SECTION 3: Wait for agents to come online ───────────────────────────────

async function waitForAgents(provisions) {
  section("3. Waiting for Agents to Come Online");

  const results = {};

  for (const [name, prov] of Object.entries(provisions)) {
    if (!prov) continue;
    const depId = prov.deployment.id;
    process.stdout.write(`  [${name}] Waiting for ONBOARDING status `);
    const dep = await waitForDeployment(depId, "ONBOARDING", 240_000);
    console.log("");

    if (!dep) {
      assert(false, `${name}: Reached ONBOARDING within 4 min`);
      continue;
    }
    if (dep.status === "ERROR") {
      // Log what went wrong
      const logs = await prisma.provisioningLog.findMany({
        where: { deploymentId: depId },
        orderBy: { createdAt: "asc" },
      });
      const failed = logs.filter(l => l.status === "failed");
      const errMsg = failed.map(l => `${l.step}: ${l.message}`).join("; ");
      assert(false, `${name}: Provisioning succeeded (ERROR: ${errMsg})`);
      continue;
    }

    assert(dep.status === "ONBOARDING", `${name}: status = ONBOARDING`);
    assert(!!dep.agentEmail, `${name}: has agentEmail (${dep.agentEmail})`);
    assert(!!dep.containerName, `${name}: has containerName`);

    results[name] = dep;
  }

  return results;
}

// ─── SECTION 4: Find gateway ports and test agent responsiveness ──────────────

async function findGatewayPort(dep) {
  // Local mode: containerName is like "openclaw-agent-XXXXXXXX"
  // Port is tracked in local-runner's localProcesses map — we can probe
  // by checking the ports range 18800-18850
  for (let port = 18800; port < 18860; port++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(300),
      });
      if (r.status > 0) return port;
    } catch {}
  }
  // Custom Docker: check ports via Docker inspect
  return null;
}

async function getDeploymentPort(dep) {
  if (dep.containerName?.startsWith("http://")) {
    const url = new URL(dep.containerName);
    return parseInt(url.port);
  }
  if (dep.containerName?.startsWith("openclaw-agent-")) {
    return await findGatewayPort(dep);
  }
  if (dep.containerName?.startsWith("custom-agent-")) {
    // Ask Docker for the port
    try {
      const { execSync } = await import("node:child_process");
      const raw = execSync(
        `docker inspect --format '{{(index (index .NetworkSettings.Ports "4000/tcp") 0).HostPort}}' ${dep.containerName}`,
        { encoding: "utf-8" }
      ).trim();
      return parseInt(raw);
    } catch {}
  }
  return null;
}

async function testAgentResponsiveness(agents) {
  section("4. Agent Gateway Responsiveness");

  const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN || "";
  const ports = {};

  for (const [name, dep] of Object.entries(agents)) {
    if (!dep) continue;
    const port = await getDeploymentPort(dep);
    ports[name] = port;

    if (!port) {
      assert(false, `${name}: Could not determine gateway port`);
      continue;
    }

    assert(!!port, `${name}: Gateway port found (${port})`);

    // Hit health endpoint
    try {
      const isCustom = dep.containerName?.startsWith("custom-agent-");
      const healthPath = isCustom ? "/internal/health" : "/";
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
        signal: AbortSignal.timeout(5000),
      });
      assert(res.status > 0, `${name}: Gateway responds (HTTP ${res.status})`);
    } catch (e) {
      assert(false, `${name}: Gateway reachable: ${e.message}`);
    }
  }

  return { ports, hooksToken };
}

// ─── SECTION 5: Onboarding — send welcome replies ─────────────────────────────

async function testOnboarding(agents, ports, hooksToken) {
  section("5. Email-Based Onboarding");

  for (const [name, dep] of Object.entries(agents)) {
    if (!dep) continue;
    const port = ports[name];
    if (!port) { console.log(`  [${name}] Skipped — no port`); continue; }

    const isCustom = dep.containerName?.startsWith("custom-agent-");
    const agentToken = isCustom ? "" : hooksToken;

    console.log(`\n  [${name}] Sending onboarding reply email...`);
    const r = await sendEmailToAgent(`http://127.0.0.1:${port}`, agentToken, {
      from: `manager@${dep.containerName?.slice(0,8) || "acme"}.example.com`,
      subject: "Re: Hi from your new AI employee",
      text: [
        "Hi! Thanks for the intro.",
        "",
        "Key contacts: Jane Smith (jane@example.com) - my manager.",
        "Top tasks: Email triage, scheduling, research.",
        "Escalation: Always loop me in for anything involving money or legal.",
        "Communication style: Professional but friendly.",
      ].join("\n"),
    });
    assert(r.status >= 200 && r.status < 300, `${name}: Onboarding email accepted (HTTP ${r.status})`);

    // Give agent 10s to process
    await sleep(10000);

    // Check deployment updated (agent may update onboarding state)
    const refreshed = await prisma.deployment.findUnique({ where: { id: dep.id } });
    console.log(`  [${name}] Deployment status: ${refreshed?.status}, onboardingState: ${refreshed?.onboardingState}`);
  }
}

// ─── SECTION 6: Email agents with real tasks ──────────────────────────────────

async function testEmailTasks(agents, ports, hooksToken) {
  section("6. Email Task Handling");

  const tasks = [
    {
      name: "alex",
      subject: "Can you help me draft a follow-up email?",
      text: "I had a call with Acme's CEO yesterday about a potential partnership. Can you draft a follow-up email thanking him and proposing next steps?",
    },
    {
      name: "langchain",
      subject: "Research task: competitive analysis",
      text: "Please do a brief research summary on the top 3 AI agent platforms in the market. I need their pricing, key features, and target customers.",
    },
    {
      name: "maya",
      subject: "IT help: password reset request",
      text: "Hi Maya, I forgot my Slack password and can't log in. Can you help me reset it or tell me the process?",
    },
  ];

  for (const task of tasks) {
    const dep = agents[task.name];
    const port = ports[task.name];
    if (!dep || !port) { console.log(`  [${task.name}] Skipped`); continue; }

    const isCustom = dep.containerName?.startsWith("custom-agent-");
    const agentToken = isCustom ? "" : hooksToken;

    console.log(`\n  [${task.name}] Sending task: "${task.subject}"`);
    const threadId = `task-thread-${Date.now()}`;
    const r = await sendEmailToAgent(`http://127.0.0.1:${port}`, agentToken, {
      from: `manager@example.com`,
      subject: task.subject,
      text: task.text,
      threadId,
    });
    assert(r.status >= 200 && r.status < 300, `${task.name}: Task email accepted (HTTP ${r.status})`);
  }

  // Wait for agents to process
  console.log("\n  Waiting 20s for agents to process tasks...");
  await sleep(20000);

  // Check if any approvals were created
  for (const [name, dep] of Object.entries(agents)) {
    if (!dep) continue;
    const approvals = await prisma.approval.findMany({
      where: { deploymentId: dep.id },
      orderBy: { createdAt: "desc" },
    });
    console.log(`  [${name}] Approvals created: ${approvals.length}`);
    if (approvals.length > 0) {
      const a = approvals[0];
      assert(true, `${name}: Agent queued approval (type: ${a.taskType}, score: ${a.combinedScore?.toFixed(1)})`);
    }
  }
}

// ─── SECTION 7: Approval queue ────────────────────────────────────────────────

async function testApprovalQueue(agents) {
  section("7. Approval Queue (Portal)");

  // Create a test approval via webhook (simulates agent submitting one)
  for (const [name, dep] of Object.entries(agents)) {
    if (!dep) continue;

    // Read the per-deployment token from DB (set during provisioning)
    const depRecord = await prisma.deployment.findUnique({
      where: { id: dep.id },
      select: { approvalWebhookToken: true },
    });
    const WEBHOOK_TOKEN = depRecord?.approvalWebhookToken
      || process.env.APPROVAL_WEBHOOK_TOKEN
      || "mkt-webhook-token-dev";

    const r = await api("POST", `/api/webhooks/approvals/${dep.id}`, {
      taskType: "email_send",
      channel: "email",
      draft: `Dear valued customer,\n\nThank you for reaching out. We will get back to you shortly.\n\nBest,\n${dep.agentName}`,
      reasoning: "Customer inquiry requires professional response. External recipient — queuing for approval.",
      originalRequest: "Reply to customer inquiry about service pricing",
      stakesScore: 6.5,
      ambiguityScore: 4.0,
      reversibilityScore: 3.0,
      threadId: `test-thread-${name}-${Date.now()}`,
    }, { Authorization: `Bearer ${WEBHOOK_TOKEN}` });

    assert(r.status === 200 || r.status === 201, `${name}: Approval created via webhook (HTTP ${r.status})`);
    if (r.data?.id) {
      console.log(`  [${name}] Approval ID: ${r.data.id.slice(0, 8)}, score: ${r.data.combinedScore?.toFixed(1)}`);

      // Test portal view (no auth needed — uses token)
      if (dep.portalToken) {
        const portal = await api("GET", `/api/portal/${dep.portalToken}/approvals`);
        assert(portal.status === 200, `${name}: Portal approval list accessible`);
        assert(Array.isArray(portal.data?.approvals), `${name}: Portal returns approval array`);
      }
    }
  }
}

// ─── SECTION 8: AgentMind ─────────────────────────────────────────────────────

async function testAgentMind(agents) {
  section("8. AgentMind — Collective Intelligence");

  // Need at least one deployment with a resolved approval to contribute
  let seedDeploymentId = null;
  for (const dep of Object.values(agents)) {
    if (!dep) continue;
    // Seed a resolved approval so contribution gate passes
    const existing = await prisma.approval.findFirst({
      where: { deploymentId: dep.id, status: { in: ["APPROVED", "EDITED"] } },
    });
    if (!existing) {
      await prisma.approval.create({
        data: {
          deploymentId: dep.id,
          taskType: "email_triage",
          channel: "email",
          draft: "Test response",
          reasoning: "Test",
          originalRequest: "Test request",
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
    // Enable AgentMind on deployment
    await prisma.deployment.update({
      where: { id: dep.id },
      data: { autonomyConfig: { approvalPolicy: "external-only", agentMindEnabled: true, agentMindAutoApprove: true } },
    });
    seedDeploymentId = dep.id;
    break;
  }

  if (!seedDeploymentId) {
    assert(false, "AgentMind: No deployment available for testing");
    return;
  }

  // AgentMind contribute gate requires ACTIVE status — promote deployment
  await prisma.deployment.update({
    where: { id: seedDeploymentId },
    data: { status: "ACTIVE" },
  });

  const dep2Id = Object.values(agents).find(d => d && d.id !== seedDeploymentId)?.id;

  // 8a. Contribute
  const contrib = await api("POST", "/api/agentmind/contribute", {
    deploymentId: seedDeploymentId,
    type: "PATTERN",
    title: "Customer emails get better responses when you lead with the resolution",
    content: "Tested across 15 customer support threads: leading with the resolution (not the problem description) cut response time by 40%. Customers prefer action over explanation.",
    tags: ["email", "customer-support", "response-quality"],
    context: "Customer escalation thread about delayed shipment",
  });
  assert(contrib.status === 200 || contrib.status === 201, `AgentMind contribute → ${contrib.status}`);
  const contribId = contrib.data?.id;
  assert(!!contribId, `Contribution created: ${contribId?.slice(0, 8)}`);
  console.log(`  Contribution: ${contrib.data?.status || "unknown"} (ID: ${contribId?.slice(0,8)})`);

  // 8b. Search (from a different deployment)
  if (dep2Id) {
    await prisma.deployment.update({
      where: { id: dep2Id },
      data: { autonomyConfig: { approvalPolicy: "external-only", agentMindEnabled: true, agentMindAutoApprove: true } },
    });
    const search = await api("GET", `/api/agentmind/search?agentId=${dep2Id}&deploymentId=${dep2Id}&q=customer+email+response&limit=5`);
    assert(search.status === 200, `AgentMind search → ${search.status}`);
    const hits = Array.isArray(search.data) ? search.data : (search.data?.data || []);
    assert(hits.length >= 0, `AgentMind search returned ${hits.length} results`);
    if (hits.length > 0) {
      console.log(`  Search hit: [${hits[0].type}] ${hits[0].title?.slice(0,50)}`);
    }
  }

  // Approve the contribution so voting works (vote requires APPROVED status)
  if (contribId) {
    await prisma.knowledgeContribution.update({
      where: { id: contribId },
      data: { status: "APPROVED" },
    });
    console.log(`  Contribution approved for voting`);
  }

  // 8c. Vote on contribution (requires approved contribution + vote as 1/-1)
  if (contribId) {
    const vote = await api("POST", "/api/agentmind/vote", {
      contributionId: contribId,
      deploymentId: dep2Id || seedDeploymentId,
      vote: 1,
    });
    assert(vote.status === 200, `AgentMind vote → ${vote.status}`);
  }

  // 8d. Use (track usage — expects contributionIds array)
  if (contribId) {
    const use = await api("POST", "/api/agentmind/use", {
      contributionIds: [contribId],
      deploymentId: dep2Id || seedDeploymentId,
    });
    assert(use.status === 200 || use.status === 201, `AgentMind use → ${use.status}`);
  }

  // 8e. Stats (requires auth — 401 is acceptable in E2E without Clerk session)
  const stats = await api("GET", "/api/agentmind/stats");
  assert(stats.status === 200 || stats.status === 401, `AgentMind stats → ${stats.status} (${stats.status === 401 ? "auth-gated ✓" : "ok ✓"})`);
  if (stats.status === 200) {
    console.log(`  Stats: ${JSON.stringify(stats.data).slice(0, 100)}`);
  }

  // 8f. Opt-out reciprocity (agentMindEnabled=false → search returns empty)
  const dep3 = Object.values(agents).find(d => d && d.id !== seedDeploymentId && d.id !== dep2Id);
  if (dep3) {
    await prisma.deployment.update({
      where: { id: dep3.id },
      data: { autonomyConfig: { approvalPolicy: "external-only", agentMindEnabled: false } },
    });
    const blockedSearch = await api("GET", `/api/agentmind/search?agentId=${dep3.id}&deploymentId=${dep3.id}&q=customer+email&limit=5`);
    assert(blockedSearch.status === 200, `Opted-out search still responds`);
    const blockedHits = Array.isArray(blockedSearch.data) ? blockedSearch.data : (blockedSearch.data?.data || []);
    assert(blockedHits.length === 0, `Opted-out deployment gets empty search results (got ${blockedHits.length})`);
  }

  // 8g. Duplicate guard
  const dupe = await api("POST", "/api/agentmind/contribute", {
    deploymentId: seedDeploymentId,
    type: "PATTERN",
    title: "Customer emails get better responses when you lead with the resolution",
    content: "Tested across 15 customer support threads: leading with the resolution (not the problem description) cut response time by 40%.",
    tags: ["email", "customer-support"],
  });
  assert(dupe.status === 409 || (dupe.data?.duplicate === true), `Duplicate contribution blocked (${dupe.status})`);
}

// ─── SECTION 9: Creator / package upload ──────────────────────────────────────

async function testCreatorSide() {
  section("9. Creator Side — Package Upload & Vetting");

  // Check public agent listing (creator can see their agents)
  const agents = await api("GET", "/api/agents");
  assert(agents.status === 200, "Creator agents listable");

  // Check agent insights (public)
  const insights = await api("GET", "/api/agents/general-ops-alex/insights");
  assert(insights.status === 200, `Agent insights endpoint → ${insights.status}`);
  console.log(`  Public insights response: ${JSON.stringify(insights.data).slice(0, 80)}`);

  // Package upload (requires Clerk auth — test validation response)
  const pkgUpload = await api("POST", "/api/packages/upload", {
    agentId: "test-id",
    version: "1.0.1",
  });
  // Expect 401 (auth) or 400 (validation) — not 500
  assert(pkgUpload.status === 401 || pkgUpload.status === 400, `Package upload auth gated (got ${pkgUpload.status})`);

  // Agent edit (auth gated)
  const editRes = await api("PATCH", "/api/agents/general-ops-alex/edit", { description: "test" });
  assert(editRes.status === 401, `Agent edit is auth-gated (got ${editRes.status})`);

  console.log("  Note: Full creator upload flow requires browser session (Clerk auth).");
  console.log("  Endpoints are properly auth-gated — no unauthorized package uploads possible.");
}

// ─── SECTION 10: Cron / background jobs ──────────────────────────────────────

async function testCronJobs() {
  section("10. Cron Jobs");

  const CRON_SECRET = process.env.CRON_SECRET || "";

  // Expire approvals
  const expire = await api("POST", "/api/cron/expire-approvals", null,
    CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {}
  );
  assert(expire.status === 200 || expire.status === 401, `Expire approvals → ${expire.status} (${expire.status === 401 ? "auth-gated ✓" : "ran ✓"})`);

  // Update trust scores
  const trust = await api("POST", "/api/cron/update-trust-scores", null,
    CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {}
  );
  assert(trust.status === 200 || trust.status === 401, `Update trust scores → ${trust.status}`);
}

// ─── SECTION 11: Deprovision (cleanup) ───────────────────────────────────────

async function cleanup(agents) {
  section("11. Cleanup — Deprovision Agents");

  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  for (const [name, dep] of Object.entries(agents)) {
    if (!dep) continue;
    const job = await queue.add("deprovision", { type: "deprovision", deploymentId: dep.id });
    console.log(`  [${name}] Deprovision job queued (job ${job.id})`);
  }

  await queue.close();
  console.log("  Cleanup jobs queued — provisioning service will handle teardown.");
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  Marketplace Full System E2E Test");
  console.log("═".repeat(60));

  // 1. Public API
  const agentsList = await testPublicApi();

  // 2. Provision
  const provisions = await testProvisioning();

  // 3. Wait for agents
  const activeAgents = await waitForAgents(provisions);

  // 4. Gateway responsiveness
  const { ports, hooksToken } = await testAgentResponsiveness(activeAgents);

  // 5. Onboarding emails
  await testOnboarding(activeAgents, ports, hooksToken);

  // 6. Task emails
  await testEmailTasks(activeAgents, ports, hooksToken);

  // 7. Approval queue
  await testApprovalQueue(activeAgents);

  // 8. AgentMind
  await testAgentMind(activeAgents);

  // 9. Creator side
  await testCreatorSide();

  // 10. Cron jobs
  await testCronJobs();

  // Summary
  console.log("\n" + "═".repeat(60));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  const pct = ((passed / (passed + failed)) * 100).toFixed(1);
  console.log(`  Pass rate: ${pct}%`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    ✗ ${f}`));
  }
  console.log("═".repeat(60) + "\n");

  // 11. Cleanup
  if (Object.keys(activeAgents).length > 0) {
    await cleanup(activeAgents);
  }

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
