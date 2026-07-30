#!/usr/bin/env node
/**
 * Demo seed script — creates a fully populated demo environment.
 *
 * Usage:
 *   node scripts/seed-demo.mjs --buyer-org <clerkOrgId> --creator-user <clerkUserId>
 *
 * Flags:
 *   --buyer-org   Clerk org ID for the buyer company (org_xxx)
 *   --creator-user Clerk user ID for the creator account (user_xxx)
 *   --reset       Drop existing demo data and re-seed from scratch
 *
 * What gets created:
 *   - Creator account (langchain-ops creator)
 *   - LangChain Operations Agent (LIVE, MANUALLY_APPROVED v1.0.0)
 *   - Buyer company (Acme Corp) linked to your Clerk org
 *   - Active deployment with 30 days of history
 *   - 3 pending approval cards (ready to action in the demo)
 *   - 18 resolved approvals (for stats: 75% approval rate, 42 total actions)
 *   - Trust scores for 3 task types
 *   - 1 approved AgentMind knowledge contribution
 *   - 1 five-star review
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Load env ──────────────────────────────────────────────────────────────────

function loadEnv() {
  const candidates = [
    resolve(__dirname, "../apps/web/.env.local"),
    resolve(__dirname, "../apps/web/.env"),
    resolve(__dirname, "../.env.prod"),
    resolve(__dirname, "../.env"),
  ];
  // Load all candidate files (later files don't overwrite earlier ones)
  for (const f of candidates) {
    if (existsSync(f)) {
      const lines = readFileSync(f, "utf-8").split("\n");
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
      console.log(`Loaded env from ${f}`);
    }
  }
}

loadEnv();

if (!process.env.DATABASE_URL) {
  console.error("❌  DATABASE_URL not found. Add it to apps/web/.env.local");
  process.exit(1);
}

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const BUYER_ORG    = flag("--buyer-org");
const CREATOR_USER = flag("--creator-user");
const RESET        = args.includes("--reset");

if (!BUYER_ORG || !CREATOR_USER) {
  console.error("Usage: node scripts/seed-demo.mjs --buyer-org <clerkOrgId> --creator-user <clerkUserId>");
  process.exit(1);
}

// ── Prisma ────────────────────────────────────────────────────────────────────

const { PrismaClient } = require(
  resolve(__dirname, "../node_modules/.pnpm/@prisma+client@6.19.2_prism_6b2b1af085fe6797f5a5ea830937a8e3/node_modules/@prisma/client")
);
const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const hoursAgo = (n) => new Date(Date.now() - n * 60 * 60 * 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱  Seeding demo data...\n");

  // ── Reset ──────────────────────────────────────────────────────────────────
  if (RESET) {
    console.log("🗑   Resetting existing demo deployment data...");
    const company = await prisma.company.findUnique({ where: { clerkOrgId: BUYER_ORG } });
    if (company) {
      const deps = await prisma.deployment.findMany({ where: { companyId: company.id } });
      for (const d of deps) {
        await prisma.trustScore.deleteMany({ where: { deploymentId: d.id } });
        await prisma.approval.deleteMany({ where: { deploymentId: d.id } });
        await prisma.review.deleteMany({ where: { deploymentId: d.id } });
        await prisma.knowledgeVote.deleteMany({ where: { deploymentId: d.id } });
        await prisma.contributionComment.deleteMany({ where: { deploymentId: d.id } });
        await prisma.knowledgeContribution.deleteMany({ where: { deploymentId: d.id } });
      }
      // Only delete FIRED deployments — keep ACTIVE/PROVISIONING ones alive
      await prisma.deployment.deleteMany({ where: { companyId: company.id, status: "FIRED" } });
    }
    console.log("✓  Reset complete\n");
  }

  // ── 1. Creator ─────────────────────────────────────────────────────────────
  const creator = await prisma.creator.upsert({
    where: { clerkUserId: CREATOR_USER },
    update: {},
    create: {
      clerkUserId: CREATOR_USER,
      displayName: "Demo Creator",
      email: `demo-creator-${CREATOR_USER.slice(-6)}@example.com`,
      stripeOnboarded: true,
      stripeAccountId: "acct_demo_placeholder",
    },
  });
  console.log(`✓  Creator: ${creator.displayName} (${creator.id})`);

  // ── 2. Agent ───────────────────────────────────────────────────────────────
  const agent = await prisma.agent.upsert({
    where: { slug: "langchain-ops" },
    update: {
      status: "LIVE",
      currentVersion: "1.0.0",
      averageRating: 4.8,
      totalDeployments: 12,
      avgApprovalRate: 74,
    },
    create: {
      slug: "langchain-ops",
      name: "LangChain Operations Agent",
      tagline: "A customizable operations agent built on LangGraph — fork it, extend it, make it yours.",
      description:
        "The LangChain Operations Agent handles email triage, task execution, and approval routing out of the box. " +
        "Built on LangGraph with a FastAPI adapter that implements the full marketplace contract. " +
        "It autonomously searches shared knowledge before acting and contributes learnings back after corrections — " +
        "so every deployment makes the network smarter over time.",
      category: "GENERAL",
      pricePerMonth: 29900,
      modelTier: "SONNET",
      runtime: "CUSTOM",
      creatorId: creator.id,
      status: "LIVE",
      currentVersion: "1.0.0",
      averageRating: 4.8,
      totalDeployments: 12,
      avgApprovalRate: 74,
    },
  });
  console.log(`✓  Agent: ${agent.name} (${agent.id})`);

  // Capabilities
  await prisma.capability.deleteMany({ where: { agentId: agent.id } });
  await prisma.capability.createMany({
    data: [
      { agentId: agent.id, name: "Email triage", description: "Reads and categorizes incoming email, drafts responses" },
      { agentId: agent.id, name: "Task execution", description: "Breaks down requests into steps and executes them" },
      { agentId: agent.id, name: "Risk assessment", description: "Scores tasks on stakes, ambiguity, and reversibility to route approvals" },
      { agentId: agent.id, name: "Approval routing", description: "Queues risky actions for human review before executing" },
      { agentId: agent.id, name: "Research", description: "Researches topics and delivers structured summaries" },
    ],
  });

  // AgentVersion
  await prisma.agentVersion.upsert({
    where: { id: `demo-version-${agent.id}` },
    update: {},
    create: {
      id: `demo-version-${agent.id}`,
      agentId: agent.id,
      version: "1.0.0",
      packageUrl: "storage://langchain-ops/1.0.0",
      vetStatus: "MANUALLY_APPROVED",
      publishedAt: daysAgo(14),
      changelog: "Initial release.",
      manifestData: {
        name: "LangChain Operations Agent",
        slug: "langchain-ops",
        version: "1.0.0",
        runtime: "custom",
        modelTier: "sonnet",
        pricePerMonth: 29900,
      },
    },
  });
  console.log(`✓  AgentVersion 1.0.0 (MANUALLY_APPROVED)`);

  // ── 3. Company ─────────────────────────────────────────────────────────────
  const company = await prisma.company.upsert({
    where: { clerkOrgId: BUYER_ORG },
    update: { name: "Acme Corp", domain: "acme.com" },
    create: {
      clerkOrgId: BUYER_ORG,
      name: "Acme Corp",
      domain: "acme.com",
      plan: "PAY_PER_AGENT",
    },
  });
  console.log(`✓  Company: ${company.name} (${company.id})`);

  // ── 4. Deployment ──────────────────────────────────────────────────────────
  // Check for existing demo deployment — prefer ACTIVE, then any non-FIRED
  let deployment = await prisma.deployment.findFirst({
    where: { companyId: company.id, agentId: agent.id, status: "ACTIVE" },
  }) ?? await prisma.deployment.findFirst({
    where: { companyId: company.id, agentId: agent.id, status: { not: "FIRED" } },
  });

  if (deployment) {
    // Ensure name and status are correct on existing deployment
    deployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: { agentName: "Alex", status: "ACTIVE", onboardingState: "LIVE" },
    });
  } else {
    deployment = await prisma.deployment.create({
      data: {
        companyId: company.id,
        agentId: agent.id,
        agentVersion: "1.0.0",
        agentName: "Alex",
        agentEmail: "alex-demo@agentmail.to",
        status: "ACTIVE",
        onboardingState: "LIVE",
        autoUpdate: true,
        containerName: "demo-container-placeholder",
        createdAt: daysAgo(30),
        autonomyConfig: {
          approvalPolicy: "risk-based",
          approvalRiskThreshold: 6.0,
          autoApproveList: ["@acme.com"],
          requireApprovalList: [],
          agentMindEnabled: true,
          agentMindAutoApprove: false,
        },
        onboardingData: {
          approval_policy: "risk-based",
          company_context: "Acme Corp is a mid-market SaaS company. Alex handles vendor communications, customer support escalations, and internal ops requests.",
          auto_approve_list: "@acme.com",
        },
        managerEmail: "ops@acme.com",
        allowedEmails: ["@acme.com", "ops@acme.com"],
      },
    });
  }
  console.log(`✓  Deployment: ${deployment.agentName} — ${deployment.id} (ACTIVE)`);

  // ── 5. Resolved approvals (history for stats) ──────────────────────────────
  // Check if we already have resolved approvals
  const existingResolved = await prisma.approval.count({
    where: { deploymentId: deployment.id, status: { not: "PENDING" } },
  });

  if (existingResolved === 0) {
    const resolvedApprovals = [
      // Email replies (approved)
      { taskType: "email-reply", status: "APPROVED", draft: "Hi Sarah, thanks for reaching out. I've reviewed the Q2 invoice and everything looks correct. I'll have this processed by end of week.", reasoning: "Standard vendor invoice acknowledgement. Low stakes, reversible.", stakes: 3, ambiguity: 2, reversibility: 2, combined: 2.5, daysAgoN: 28 },
      { taskType: "email-reply", status: "APPROVED", draft: "Hi Team, just a reminder that the vendor portal access request needs to be approved by Thursday EOD.", reasoning: "Internal reminder — no external action, fully reversible.", stakes: 2, ambiguity: 1, reversibility: 1, combined: 1.8, daysAgoN: 26 },
      { taskType: "email-reply", status: "EDITED",  draft: "Hi Marcus, I'd be happy to schedule a call to discuss the renewal terms. Would Wednesday at 2pm work?", reasoning: "Scheduling coordination — medium stakes as it commits calendar time.", stakes: 4, ambiguity: 3, reversibility: 4, combined: 3.7, daysAgoN: 25 },
      { taskType: "email-reply", status: "APPROVED", draft: "Hi Priya, the contract amendment has been reviewed. We'll need sign-off from legal before proceeding — I'll loop them in.", reasoning: "Contract discussion. Escalating to legal is the right call.", stakes: 6, ambiguity: 4, reversibility: 5, combined: 5.2, daysAgoN: 23 },
      { taskType: "email-reply", status: "APPROVED", draft: "Thanks for the bug report. I've logged this as P2 in our tracker and assigned it to the platform team. Expected resolution: 3 business days.", reasoning: "Support escalation — standard response, sets expectations clearly.", stakes: 3, ambiguity: 2, reversibility: 2, combined: 2.7, daysAgoN: 22 },
      { taskType: "email-reply", status: "APPROVED", draft: "Hi David, the NDA has been countersigned and I'm returning it attached. Please confirm receipt.", reasoning: "Document return — legal doc already signed by both parties.", stakes: 5, ambiguity: 2, reversibility: 3, combined: 3.8, daysAgoN: 20 },
      { taskType: "email-reply", status: "REJECTED", draft: "Hi James, I'm authorising the $25,000 payment to Vendor ID #8823. Please proceed.", reasoning: "High-value payment authorisation — needs explicit human sign-off.", stakes: 9, ambiguity: 3, reversibility: 9, combined: 8.5, daysAgoN: 18 },
      { taskType: "email-reply", status: "APPROVED", draft: "Hi Lin, I've rescheduled the vendor review to next Thursday at 10am and sent calendar invites to all attendees.", reasoning: "Meeting rescheduling — reversible, low stakes.", stakes: 2, ambiguity: 1, reversibility: 2, combined: 1.8, daysAgoN: 16 },
      // Research tasks (all auto-approved after initial trust built)
      { taskType: "research", status: "APPROVED", draft: "Summary: Top 3 alternatives to Zendesk for mid-market SaaS — Intercom ($89/seat), Front ($79/seat), Freshdesk ($49/seat). Full comparison attached.", reasoning: "Research request — no external action, fully safe.", stakes: 1, ambiguity: 1, reversibility: 1, combined: 1.0, daysAgoN: 21 },
      { taskType: "research", status: "APPROVED", draft: "Q1 vendor spend analysis complete. Total: $142k. Top 3: AWS ($58k), Salesforce ($31k), Stripe ($22k). Attached: breakdown by category.", reasoning: "Internal data summary — read-only, no external disclosure.", stakes: 2, ambiguity: 1, reversibility: 1, combined: 1.4, daysAgoN: 14 },
      { taskType: "research", status: "APPROVED", draft: "Competitive landscape update: Two new entrants in the ops automation space this quarter. Full brief in Notion.", reasoning: "Market research summary — non-sensitive, read-only.", stakes: 1, ambiguity: 1, reversibility: 1, combined: 1.0, daysAgoN: 9 },
      // Send email tasks
      { taskType: "send-email", status: "APPROVED", draft: "Hi Claire, following up on the partnership proposal we discussed last week. Are you available for a 30-min call this week?", reasoning: "Outbound follow-up email — moderate stakes, represents the company externally.", stakes: 5, ambiguity: 3, reversibility: 5, combined: 4.5, daysAgoN: 17 },
      { taskType: "send-email", status: "EDITED",  draft: "Dear Mr. Chen, we'd like to formally terminate our contract effective 30 days from today per clause 12.3.", reasoning: "Contract termination — high stakes, irreversible, requires human sign-off.", stakes: 9, ambiguity: 2, reversibility: 9, combined: 8.3, daysAgoN: 13 },
      { taskType: "send-email", status: "APPROVED", draft: "Hi Team, the all-hands meeting has been moved to Friday at 3pm. Zoom link unchanged.", reasoning: "Internal meeting update — low stakes, fully reversible.", stakes: 2, ambiguity: 1, reversibility: 2, combined: 1.7, daysAgoN: 11 },
      { taskType: "send-email", status: "APPROVED", draft: "Hi Raj, I've compiled the RFP responses from 4 vendors and will send the comparison matrix by EOD tomorrow.", reasoning: "Procurement coordination — standard, sets expectations.", stakes: 3, ambiguity: 2, reversibility: 3, combined: 2.8, daysAgoN: 7 },
      { taskType: "send-email", status: "REJECTED", draft: "Hi Board, I wanted to share our internal Q2 projections ahead of tomorrow's meeting. Revenue: $2.1M, Churn: 4.2%.", reasoning: "Sharing sensitive financial projections externally — needs explicit board clearance.", stakes: 9, ambiguity: 5, reversibility: 8, combined: 8.1, daysAgoN: 5 },
      { taskType: "send-email", status: "APPROVED", draft: "Hi Samira, the onboarding materials for your new hire are attached. Please share the Notion link once they have access.", reasoning: "HR onboarding — low stakes, internal.", stakes: 2, ambiguity: 1, reversibility: 2, combined: 1.7, daysAgoN: 4 },
      { taskType: "email-reply", status: "APPROVED", draft: "Hi Ethan, confirmed — the legal review is scheduled for next Tuesday. I'll send a prep checklist beforehand.", reasoning: "Scheduling confirmation — low stakes, reversible.", stakes: 3, ambiguity: 1, reversibility: 3, combined: 2.5, daysAgoN: 2 },
    ];

    for (const a of resolvedApprovals) {
      const created = daysAgo(a.daysAgoN);
      const resolved = new Date(created.getTime() + 2 * 60 * 60 * 1000); // resolved 2h later
      await prisma.approval.create({
        data: {
          deploymentId: deployment.id,
          taskType: a.taskType,
          channel: "email",
          draft: a.draft,
          reasoning: a.reasoning,
          originalRequest: `[Demo email that triggered this ${a.taskType} action]`,
          stakesScore: a.stakes,
          ambiguityScore: a.ambiguity,
          reversibilityScore: a.reversibility,
          combinedScore: a.combined,
          status: a.status,
          resolvedAt: resolved,
          expiresAt: new Date(created.getTime() + 48 * 60 * 60 * 1000),
          createdAt: created,
          resolutionAction: a.status === "EDITED" ? a.draft + " [edited by manager]" : null,
          rejectionReason: a.status === "REJECTED" ? "Too sensitive — needs direct manager action." : null,
        },
      });
    }
    console.log(`✓  18 resolved approvals (history)`);
  } else {
    console.log(`·  Skipped resolved approvals (already exist)`);
  }

  // ── 6. Pending approvals (ready to action in demo) ─────────────────────────
  await prisma.approval.deleteMany({
    where: { deploymentId: deployment.id, status: "PENDING" },
  });

  await prisma.approval.createMany({
    data: [
      {
        deploymentId: deployment.id,
        taskType: "send-email",
        channel: "email",
        draft:
          "Hi Michael,\n\nFollowing up on our conversation last week — I wanted to confirm that we're moving forward with the expanded SLA terms at $8,400/year. I'll have legal prepare the addendum and send it over by Thursday.\n\nBest,\nAlex",
        reasoning:
          "Outbound email committing to a $8,400 annual contract term. High financial stakes and externally irreversible — queued for approval per risk-based policy (combined score 7.8).",
        originalRequest:
          "Email from ops@acme.com: 'Alex, please follow up with Michael at TechVendor and confirm the SLA expansion we discussed. They need confirmation by end of week.'",
        stakesScore: 8,
        ambiguityScore: 6,
        reversibilityScore: 9,
        combinedScore: 7.8,
        status: "PENDING",
        expiresAt: daysFromNow(2),
        createdAt: hoursAgo(3),
      },
      {
        deploymentId: deployment.id,
        taskType: "email-reply",
        channel: "email",
        draft:
          "Hi Sarah,\n\nThanks for flagging this. I've reviewed the invoice #INV-2847 and there's a discrepancy of $1,200 from what was quoted. I'll reach out to the vendor to request a corrected invoice and hold payment until resolved.\n\nI'll keep you updated.\n\nAlex",
        reasoning:
          "Disputing a vendor invoice and holding payment. Moderate financial stakes, action is reversible but involves external communication — combined score 6.2.",
        originalRequest:
          "Email from sarah@acme.com: 'Alex, the Cloudify invoice doesn't match our quote. Can you sort this out before the payment run on Friday?'",
        stakesScore: 6,
        ambiguityScore: 5,
        reversibilityScore: 6,
        combinedScore: 6.2,
        status: "PENDING",
        expiresAt: daysFromNow(2),
        createdAt: hoursAgo(1),
      },
      {
        deploymentId: deployment.id,
        taskType: "email-reply",
        channel: "email",
        draft:
          "Hi Carlos,\n\nHappy to help — I've pulled the Q1 vendor spend report. Total vendor expenditure was $142,300 across 18 vendors. The top three by spend: AWS ($58k), Salesforce ($31k), Stripe ($22k). I've attached the full breakdown by category.\n\nLet me know if you need anything else.\n\nAlex",
        reasoning:
          "Sharing internal financial spend data externally. Moderate sensitivity — score 5.8, just below auto-execute threshold. Queued for review.",
        originalRequest:
          "Email from carlos.m@partner.com: 'Hi, I'm working on a market analysis for Acme. Would it be possible to get a summary of your vendor spend for Q1?'",
        stakesScore: 6,
        ambiguityScore: 5,
        reversibilityScore: 5,
        combinedScore: 5.8,
        status: "PENDING",
        expiresAt: daysFromNow(2),
        createdAt: hoursAgo(0.5),
      },
    ],
  });
  console.log(`✓  3 pending approvals (ready to action)`);

  // ── 7. Trust scores ────────────────────────────────────────────────────────
  const trustData = [
    { taskType: "email-reply",  approvedNoEdit: 10, edited: 2, rejected: 1, weightedScore: 83.3, autonomyLevel: "risk-based" },
    { taskType: "send-email",   approvedNoEdit: 5,  edited: 1, rejected: 2, weightedScore: 70.0, autonomyLevel: "always_queue" },
    { taskType: "research",     approvedNoEdit: 3,  edited: 0, rejected: 0, weightedScore: 100,  autonomyLevel: "auto_execute" },
  ];
  for (const t of trustData) {
    await prisma.trustScore.upsert({
      where: { deploymentId_taskType: { deploymentId: deployment.id, taskType: t.taskType } },
      update: t,
      create: { deploymentId: deployment.id, ...t },
    });
  }
  console.log(`✓  Trust scores (3 task types)`);

  // ── 8. Knowledge contribution ──────────────────────────────────────────────
  const existingContrib = await prisma.knowledgeContribution.findFirst({
    where: { deploymentId: deployment.id },
  });
  if (!existingContrib) {
    await prisma.knowledgeContribution.create({
      data: {
        agentId: agent.id,
        deploymentId: deployment.id,
        type: "RESPONSE_TEMPLATE",
        title: "Vendor invoice dispute — hold payment and request correction",
        content:
          "When a vendor invoice doesn't match the agreed quote:\n" +
          "1. Acknowledge receipt to the internal requester immediately.\n" +
          "2. Reply to the vendor referencing the original PO/quote number and itemising the discrepancy.\n" +
          "3. Hold payment explicitly — state 'payment will be held pending a corrected invoice'.\n" +
          "4. Set a follow-up reminder for 3 business days.\n" +
          "Template reply to vendor: 'Hi [Name], I'm writing regarding invoice [INV-XXX] dated [date]. " +
          "The total of [amount] does not match our agreed quote of [quoted amount] (ref: [PO number]). " +
          "Could you please issue a corrected invoice? We will process payment upon receipt. Thank you.'",
        rawContent: "Vendor invoice dispute pattern learned from corrected approval on 2026-04-22.",
        context: "Invoice from Cloudify for $8,400 didn't match quoted $7,200. Manager corrected the draft to hold payment and request correction rather than disputing via phone.",
        tags: ["vendor", "invoices", "finance", "payment"],
        status: "APPROVED",
        usageCount: 7,
        upvotes: 4,
        downvotes: 0,
        createdAt: daysAgo(20),
      },
    });
    console.log(`✓  AgentMind knowledge contribution (APPROVED, used 7x)`);
  } else {
    console.log(`·  Skipped knowledge contribution (already exists)`);
  }

  // ── 9. Review ──────────────────────────────────────────────────────────────
  const existingReview = await prisma.review.findFirst({ where: { deploymentId: deployment.id } });
  if (!existingReview) {
    await prisma.review.create({
      data: {
        deploymentId: deployment.id,
        agentId: agent.id,
        rating: 5,
        headline: "Handles vendor comms better than our old ops coordinator",
        body:
          "We deployed Alex to handle vendor communications, invoice tracking, and escalation routing. " +
          "In the first month it processed 47 emails without a single miss — and the two times it queued for approval " +
          "were genuinely the right calls (one was a $25k payment authorisation). " +
          "The risk scoring is surprisingly accurate. Highly recommend for any ops-heavy team.",
        verifiedHire: true,
        createdAt: daysAgo(5),
      },
    });
    console.log(`✓  5-star review`);
  } else {
    console.log(`·  Skipped review (already exists)`);
  }

  // ── Update agent aggregate stats ───────────────────────────────────────────
  await prisma.agent.update({
    where: { id: agent.id },
    data: { averageRating: 4.8 },
  });

  console.log(`
✅  Demo seed complete!

  Deployment ID:  ${deployment.id}
  Agent:          ${agent.name} (LIVE)
  Buyer company:  ${company.name} → Clerk org ${BUYER_ORG}
  Creator:        ${creator.displayName} → Clerk user ${CREATOR_USER}

Demo flow:
  1. Browse marketplace → find LangChain Operations Agent
  2. Log in as buyer org → Dashboard → Alex is ACTIVE
  3. Show 3 pending approvals → approve / edit / reject live
  4. Show Trust Scores tab → 3 task types with history
  5. Show Knowledge tab → 1 approved contribution used 7x
  6. Show agent listing page → 4.8 stars, 12 deployments, verified review
`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
