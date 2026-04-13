/**
 * End-to-end approval flow test:
 * 1. Set CUSTOM agent to risk-based approval (threshold 6)
 * 2. Send an email asking agent to draft a message to an external recipient (high-risk)
 * 3. Agent processes → queues approval → waits
 * 4. We check the approval queue and approve it
 * 5. Agent sends the actual email
 * 6. We verify we received the email
 */
import { PrismaClient } from "@prisma/client";
import { setTimeout as sleep } from "node:timers/promises";

const prisma = new PrismaClient();
const AGENTMAIL_API_KEY = "am_us_418452a2d1d07f40fe418274c1ac9902d162d4036426399a4eb0ca383aea2e23";
const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";
const SENDER_INBOX = "saiha-test@agentmail.to";
const CUSTOM_DEPLOYMENT_ID = "cmnvzw3wz000ars9ce4qrujqz";
const CUSTOM_EMAIL = "test-langchain-agent-test-company@agentmail.to";
const WEB_BASE = "http://localhost:3002";

async function agentMailFetch<T>(path: string, opts: { method?: string; body?: Record<string, unknown> } = {}, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${AGENTMAIL_API_BASE}${path}`, {
        method: opts.method ?? "GET",
        headers: { Authorization: `Bearer ${AGENTMAIL_API_KEY}`, "Content-Type": "application/json" },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`AgentMail ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err: any) {
      if (attempt < retries && err.message?.includes("fetch failed")) {
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function main() {
  console.log("=== Approval Flow E2E Test ===\n");

  // Step 0: Update DB to risk-based policy
  console.log("[0] Setting deployment autonomyConfig to risk-based (threshold 6)...");
  await prisma.deployment.update({
    where: { id: CUSTOM_DEPLOYMENT_ID },
    data: {
      autonomyConfig: {
        approvalPolicy: "risk-based",
        approvalRiskThreshold: 6,
        autoApproveList: "",
        requireApprovalList: "",
      },
    },
  });

  // Get portal token
  const dep = await prisma.deployment.findUniqueOrThrow({
    where: { id: CUSTOM_DEPLOYMENT_ID },
    select: { portalToken: true, approvalWebhookToken: true },
  });
  console.log(`  Portal token: ${dep.portalToken}`);
  console.log(`  Portal URL: ${WEB_BASE}/approve/${dep.portalToken}`);

  // Step 1: Send a high-risk task email
  console.log("\n[1] Sending high-risk task email to CUSTOM agent...");
  const taskEmail = await agentMailFetch<{ message_id: string; thread_id: string }>(
    `/inboxes/${encodeURIComponent(SENDER_INBOX)}/messages/send`,
    {
      method: "POST",
      body: {
        to: CUSTOM_EMAIL,
        subject: `Urgent: Send contract to client@external-corp.com`,
        text: `Hi Agent,

Please draft and send an email to client@external-corp.com with the following:

Subject: Q2 Contract Renewal
Body: "Dear Client, we are pleased to confirm the renewal of your contract for Q2 2026. The total value is $150,000. Please review and sign at your earliest convenience."

This is time-sensitive. Please draft and send this right away.

Thanks,
Manager`,
      },
    },
  );
  console.log(`  Sent: thread=${taskEmail.thread_id}`);

  // Step 2: Wait for the agent to process and queue approval
  console.log("\n[2] Waiting for agent to process and queue approval...");
  let approvalFound = false;
  let approvalId: string | undefined;

  for (let i = 0; i < 24; i++) { // 2 minutes max
    await sleep(5000);
    const elapsed = (i + 1) * 5;
    process.stdout.write(`  Checking... ${elapsed}s\r`);

    // Check DB for pending approvals
    const approvals = await prisma.approval.findMany({
      where: {
        deploymentId: CUSTOM_DEPLOYMENT_ID,
        status: "PENDING",
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    if (approvals.length > 0) {
      approvalFound = true;
      const a = approvals[0];
      approvalId = a.id;
      console.log(`\n  APPROVAL QUEUED!`);
      console.log(`    ID: ${a.id}`);
      console.log(`    Task: ${a.taskType}`);
      console.log(`    Risk: stakes=${a.stakesScore}, ambiguity=${a.ambiguityScore}, reversibility=${a.reversibilityScore}, combined=${a.combinedScore}`);
      console.log(`    Draft preview: ${(a.draft || "").slice(0, 200)}...`);
      console.log(`    Reasoning: ${(a.reasoning || "").slice(0, 200)}`);
      break;
    }
  }

  if (!approvalFound) {
    console.log("\n  No approval queued after 2 minutes.");
    console.log("  Checking agent logs...");
    const logs = await fetch("http://localhost:32782/internal/health").then(r => r.json());
    console.log("  Agent health:", JSON.stringify(logs));

    // Check Docker logs
    console.log("\n  Checking docker logs for approval-related entries...");
    await prisma.$disconnect();
    return;
  }

  // Step 3: Approve the action via portal API
  console.log(`\n[3] Approving action via portal API...`);
  const resolveUrl = `${WEB_BASE}/api/portal/${dep.portalToken}/approvals/${approvalId}/resolve`;
  console.log(`  POST ${resolveUrl}`);

  const resolveRes = await fetch(resolveUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "APPROVED" }),
  });
  const resolveBody = await resolveRes.text();
  console.log(`  Response: ${resolveRes.status} ${resolveBody.slice(0, 200)}`);

  if (!resolveRes.ok) {
    console.log("  Approval resolution failed!");
    await prisma.$disconnect();
    return;
  }

  // Step 4: Wait for agent to send the actual email
  console.log("\n[4] Waiting for agent to send email after approval...");

  const seenIds = new Set<string>();
  let replyReceived = false;

  for (let i = 0; i < 18; i++) { // 90 seconds max
    await sleep(5000);
    const elapsed = (i + 1) * 5;
    process.stdout.write(`  Checking inbox... ${elapsed}s\r`);

    const messages = await agentMailFetch<{ messages: Array<any> }>(
      `/inboxes/${encodeURIComponent(SENDER_INBOX)}/messages`,
    );

    for (const msg of messages.messages || []) {
      if (seenIds.has(msg.message_id)) continue;
      seenIds.add(msg.message_id);
      if (msg.from && !msg.from.includes("saiha-test@")) {
        const fullMsg = await agentMailFetch<any>(
          `/inboxes/${encodeURIComponent(SENDER_INBOX)}/messages/${encodeURIComponent(msg.message_id)}`,
        );
        console.log(`\n  EMAIL RECEIVED:`);
        console.log(`    From: ${fullMsg.from}`);
        console.log(`    Subject: ${fullMsg.subject}`);
        console.log(`    Text: ${(fullMsg.text || "").slice(0, 300)}`);
        replyReceived = true;
      }
    }
    if (replyReceived) break;
  }

  if (!replyReceived) {
    console.log("\n  No email received after approval within 90s");
  }

  // Step 5: Check final approval status
  console.log("\n[5] Final approval status:");
  if (approvalId) {
    const final = await prisma.approval.findUnique({ where: { id: approvalId } });
    console.log(`  Status: ${final?.status}`);
    console.log(`  Resolved by: ${final?.resolvedBy}`);
    console.log(`  Resolved at: ${final?.resolvedAt}`);
  }

  // Check trust score
  const trust = await prisma.trustScore.findFirst({
    where: { deploymentId: CUSTOM_DEPLOYMENT_ID },
  });
  if (trust) {
    console.log(`\n  Trust Score:`);
    console.log(`    Task type: ${trust.taskType}`);
    console.log(`    Approved (no edit): ${trust.approvedNoEdit}`);
    console.log(`    Edited: ${trust.edited}`);
    console.log(`    Rejected: ${trust.rejected}`);
    console.log(`    Weighted score: ${trust.weightedScore}`);
    console.log(`    Autonomy level: ${trust.autonomyLevel}`);
  }

  console.log("\n=== Test complete ===");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});
