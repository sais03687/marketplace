/**
 * Simulate the full approval → resolve → trust score flow without LLM.
 * 1. Manually insert a PENDING approval record
 * 2. Verify portal API returns it
 * 3. Resolve it (APPROVED, then EDITED, then REJECTED)
 * 4. Verify trust score updates
 * 5. Check AgentMind reflection trigger
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CUSTOM_DEPLOYMENT_ID = "cmnvzw3wz000ars9ce4qrujqz";
const WEB_BASE = "http://localhost:3002";

async function main() {
  console.log("=== Approval Simulation Test ===\n");

  // Get portal token
  const dep = await prisma.deployment.findUniqueOrThrow({
    where: { id: CUSTOM_DEPLOYMENT_ID },
    select: { portalToken: true, approvalWebhookToken: true },
  });
  const portalToken = dep.portalToken!;
  console.log(`Portal token: ${portalToken}`);

  // ─── Test 1: Insert approval + verify portal returns it ───────────
  console.log("\n[1] Creating PENDING approval...");
  const approval1 = await prisma.approval.create({
    data: {
      deploymentId: CUSTOM_DEPLOYMENT_ID,
      taskType: "email_send",
      channel: "email",
      draft: "Dear Client,\n\nWe are pleased to confirm the renewal of your contract for Q2 2026. The total value is $150,000.\n\nBest regards,\nAgent",
      reasoning: "Manager requested sending a contract renewal email to an external client. High financial stakes ($150k), external recipient.",
      stakesScore: 8.5,
      ambiguityScore: 3.0,
      reversibilityScore: 7.0,
      combinedScore: 7.05,
      originalRequest: "Please send a contract renewal email to client@external-corp.com",
      threadId: "test-thread-001",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  });
  console.log(`  Created: id=${approval1.id}, status=PENDING`);
  console.log(`  Risk: stakes=8.5, ambiguity=3.0, reversibility=7.0, combined=7.05`);

  // ─── Test 2: Portal API returns pending approvals ─────────────────
  console.log("\n[2] Checking portal API...");
  const portalRes = await fetch(`${WEB_BASE}/api/portal/${portalToken}/approvals`);
  console.log(`  GET /api/portal/${portalToken}/approvals → ${portalRes.status}`);

  if (portalRes.ok) {
    const portalData = await portalRes.json() as any;
    console.log(`  Agent: ${portalData.agentName} (${portalData.agentSlug})`);
    console.log(`  Pending approvals: ${portalData.approvals?.length || 0}`);
    if (portalData.approvals?.length > 0) {
      const a = portalData.approvals[0];
      console.log(`    [0] id=${a.id}, task=${a.taskType}, risk=${a.combinedScore}`);
      console.log(`    Draft: ${(a.draft || "").slice(0, 100)}...`);
    }
  } else {
    console.log(`  FAILED: ${await portalRes.text()}`);
  }

  // ─── Test 3: Resolve as APPROVED ──────────────────────────────────
  console.log("\n[3] Resolving as APPROVED...");
  const resolveUrl = `${WEB_BASE}/api/portal/${portalToken}/approvals/${approval1.id}/resolve`;
  const resolveRes = await fetch(resolveUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "APPROVED" }),
  });
  console.log(`  POST → ${resolveRes.status}`);
  if (resolveRes.ok) {
    const body = await resolveRes.json() as any;
    console.log(`  Result:`, JSON.stringify(body).slice(0, 200));
  } else {
    console.log(`  FAILED: ${await resolveRes.text()}`);
  }

  // Check DB
  const updated1 = await prisma.approval.findUnique({ where: { id: approval1.id } });
  console.log(`  DB status: ${updated1?.status}, resolvedBy: ${updated1?.resolvedBy}`);

  // Check trust score
  const trust1 = await prisma.trustScore.findFirst({
    where: { deploymentId: CUSTOM_DEPLOYMENT_ID, taskType: "email_send" },
  });
  if (trust1) {
    console.log(`  Trust: approved=${trust1.approvedNoEdit}, edited=${trust1.edited}, rejected=${trust1.rejected}, score=${trust1.weightedScore}, level=${trust1.autonomyLevel}`);
  } else {
    console.log(`  Trust: no record yet`);
  }

  // ─── Test 4: Create + resolve as EDITED ───────────────────────────
  console.log("\n[4] Testing EDITED resolution...");
  const approval2 = await prisma.approval.create({
    data: {
      deploymentId: CUSTOM_DEPLOYMENT_ID,
      taskType: "email_send",
      channel: "email",
      draft: "Hi Client, here are the Q2 numbers: Revenue $500k, Costs $200k.",
      reasoning: "Sharing financial data with external party.",
      stakesScore: 9.0,
      ambiguityScore: 2.0,
      reversibilityScore: 8.0,
      combinedScore: 7.7,
      originalRequest: "Send the Q2 financial numbers to the client",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  });

  const editRes = await fetch(`${WEB_BASE}/api/portal/${portalToken}/approvals/${approval2.id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "EDITED",
      editedText: "Hi Client, here are the Q2 numbers: Revenue $500k, Costs $200k. [CONFIDENTIAL - Do not forward]",
    }),
  });
  console.log(`  EDITED resolve → ${editRes.status}`);
  if (editRes.ok) {
    const body = await editRes.json() as any;
    console.log(`  Result:`, JSON.stringify(body).slice(0, 200));
  } else {
    console.log(`  FAILED: ${await editRes.text()}`);
  }

  const updated2 = await prisma.approval.findUnique({ where: { id: approval2.id } });
  console.log(`  DB: status=${updated2?.status}, editDiff present=${!!updated2?.editDiff}`);

  // ─── Test 5: Create + resolve as REJECTED ─────────────────────────
  console.log("\n[5] Testing REJECTED resolution...");
  const approval3 = await prisma.approval.create({
    data: {
      deploymentId: CUSTOM_DEPLOYMENT_ID,
      taskType: "email_send",
      channel: "email",
      draft: "Dear Competitor, here are our internal plans for next quarter...",
      reasoning: "Manager asked to share plans with a partner.",
      stakesScore: 10.0,
      ambiguityScore: 5.0,
      reversibilityScore: 9.0,
      combinedScore: 8.8,
      originalRequest: "Share our internal plans with the competitor",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  });

  const rejectRes = await fetch(`${WEB_BASE}/api/portal/${portalToken}/approvals/${approval3.id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "REJECTED",
      rejectionReason: "This email contains confidential information that should not be shared externally.",
    }),
  });
  console.log(`  REJECTED resolve → ${rejectRes.status}`);
  if (rejectRes.ok) {
    const body = await rejectRes.json() as any;
    console.log(`  Result:`, JSON.stringify(body).slice(0, 200));
  } else {
    console.log(`  FAILED: ${await rejectRes.text()}`);
  }

  const updated3 = await prisma.approval.findUnique({ where: { id: approval3.id } });
  console.log(`  DB: status=${updated3?.status}, rejectionReason=${updated3?.rejectionReason?.slice(0, 80)}`);

  // ─── Final: Trust score summary ───────────────────────────────────
  console.log("\n[6] Final trust score...");
  const trustFinal = await prisma.trustScore.findFirst({
    where: { deploymentId: CUSTOM_DEPLOYMENT_ID, taskType: "email_send" },
  });
  if (trustFinal) {
    console.log(`  Approved (no edit): ${trustFinal.approvedNoEdit}`);
    console.log(`  Edited: ${trustFinal.edited}`);
    console.log(`  Rejected: ${trustFinal.rejected}`);
    console.log(`  Weighted score: ${trustFinal.weightedScore}`);
    console.log(`  Autonomy level: ${trustFinal.autonomyLevel}`);
    const total = trustFinal.approvedNoEdit + trustFinal.edited + trustFinal.rejected;
    console.log(`  Total decisions: ${total}`);
  } else {
    console.log(`  No trust score record`);
  }

  // Check AgentMind entries
  const agentMindEntries = await prisma.agentMindEntry?.findMany?.({
    where: { deploymentId: CUSTOM_DEPLOYMENT_ID },
    orderBy: { createdAt: "desc" },
    take: 5,
  }).catch(() => null);
  if (agentMindEntries && agentMindEntries.length > 0) {
    console.log(`\n  AgentMind entries (recent): ${agentMindEntries.length}`);
    for (const e of agentMindEntries) {
      console.log(`    [${e.type}] ${(e.content || "").slice(0, 100)}`);
    }
  }

  console.log("\n=== Approval simulation complete ===");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});
