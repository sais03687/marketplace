/**
 * Seed test agent packages into the vetting queue.
 * Run: node scripts/seed-packages.mjs
 *
 * Creates Agent + AgentVersion (vetStatus=PENDING) + Capabilities so they
 * appear in the admin vetting queue for demo purposes.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Use your Clerk user ID as the creator so you own these packages.
// Find it: Clerk dashboard → Users → your user → User ID
const CREATOR_CLERK_ID = process.env.CREATOR_CLERK_ID || "";
const CREATOR_EMAIL = process.env.CREATOR_EMAIL || "admin@marketplace.dev";
const CREATOR_NAME = process.env.CREATOR_NAME || "Demo Creator";

const packages = [
  {
    slug: "maya-tech-support",
    name: "Maya — Tech Support Specialist",
    tagline: "Triages IT support tickets, resolves common issues, and escalates the hard ones — over email.",
    description: "Maya handles your IT support inbox end-to-end. She reads incoming tickets, diagnoses common issues (password resets, VPN trouble, software installs), resolves what she can, and routes the rest to the right team with full context. She learns from every ticket she closes.",
    category: "IT_SUPPORT",
    modelTier: "HAIKU",
    pricePerMonth: 19900,
    runtime: "CUSTOM",
    version: "1.0.0",
    capabilities: [
      { name: "Ticket triage", description: "Reads and categorises incoming IT support emails by urgency and type." },
      { name: "Common issue resolution", description: "Resolves password resets, VPN issues, and standard software problems autonomously." },
      { name: "Escalation routing", description: "Routes unresolvable tickets to the right team with a full context summary." },
      { name: "Onboarding checklists", description: "Sends and tracks new-hire IT onboarding steps via email." },
      { name: "Knowledge base building", description: "Contributes resolved-ticket patterns to AgentMind for future agents to learn from." },
    ],
  },
  {
    slug: "test-langchain-agent",
    name: "LangChain Operations Agent",
    tagline: "A customizable operations agent built on LangGraph — fork it, extend it, make it yours.",
    description: "A production-ready operations agent built on LangGraph with full approval flows, AgentMind integration, and risk assessment built in. Handles email triage, task execution, research, and escalation routing out of the box.",
    category: "GENERAL",
    modelTier: "SONNET",
    pricePerMonth: 9900,
    runtime: "CUSTOM",
    version: "1.0.0",
    capabilities: [
      { name: "Email triage", description: "Reads, classifies, and prioritises incoming emails." },
      { name: "Task execution", description: "Drafts responses, summaries, and follow-ups autonomously." },
      { name: "Risk assessment", description: "Scores actions by stakes, ambiguity, and reversibility before taking them." },
      { name: "Approval routing", description: "Routes high-risk actions to a human approval queue before executing." },
      { name: "Research", description: "Searches the web and synthesises findings into actionable summaries." },
    ],
  },
  {
    slug: "test-minimal-agent",
    name: "Minimal Test Agent",
    tagline: "Simplest possible custom agent — great starting point for builders.",
    description: "A bare-bones custom agent that echoes and acknowledges incoming emails. Use this as a starting point to build your own specialised agent on top of the marketplace platform.",
    category: "GENERAL",
    modelTier: "SONNET",
    pricePerMonth: 9900,
    runtime: "CUSTOM",
    version: "1.0.0",
    capabilities: [
      { name: "Echo", description: "Acknowledges and confirms receipt of any incoming message." },
    ],
  },
];

async function main() {
  console.log("Seeding test packages into vetting queue...\n");

  if (!CREATOR_CLERK_ID) {
    console.error("ERROR: Set CREATOR_CLERK_ID env var to your Clerk user ID.");
    console.error("  Find it: Clerk dashboard → Users → your account → User ID (user_...)");
    process.exit(1);
  }

  // Ensure creator record exists
  let creator = await prisma.creator.findUnique({
    where: { clerkUserId: CREATOR_CLERK_ID },
  });
  if (!creator) {
    creator = await prisma.creator.create({
      data: {
        clerkUserId: CREATOR_CLERK_ID,
        displayName: CREATOR_NAME,
        email: CREATOR_EMAIL,
      },
    });
    console.log(`Created creator: ${creator.displayName}`);
  } else {
    console.log(`Found creator: ${creator.displayName}`);
  }

  for (const pkg of packages) {
    // Check if agent already exists
    const existing = await prisma.agent.findUnique({ where: { slug: pkg.slug } });
    if (existing) {
      console.log(`Skipping ${pkg.slug} — already exists`);
      continue;
    }

    const agent = await prisma.agent.create({
      data: {
        slug: pkg.slug,
        name: pkg.name,
        tagline: pkg.tagline,
        description: pkg.description,
        category: pkg.category,
        modelTier: pkg.modelTier,
        pricePerMonth: pkg.pricePerMonth,
        runtime: pkg.runtime,
        creatorId: creator.id,
        status: "IN_REVIEW",
        currentVersion: pkg.version,
        capabilities: {
          create: pkg.capabilities,
        },
      },
    });

    await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        version: pkg.version,
        packageUrl: `storage://${pkg.slug}/${pkg.version}`,
        storagePath: `${pkg.slug}/${pkg.version}`,
        manifestData: {
          slug: pkg.slug,
          name: pkg.name,
          version: pkg.version,
          runtime: pkg.runtime.toLowerCase(),
          modelTier: pkg.modelTier.toLowerCase(),
          pricePerMonth: pkg.pricePerMonth,
          category: pkg.category,
        },
        vetStatus: "PENDING",
        publishedAt: null,
      },
    });

    console.log(`✓ Created ${pkg.name} (${pkg.slug}) — PENDING vetting`);
  }

  console.log("\nDone. Check /admin/agentmind or /admin to review the queue.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
