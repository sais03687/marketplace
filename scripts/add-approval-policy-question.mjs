#!/usr/bin/env node
// Appends approval-policy questions to existing Agent.onboardingQuestions
// so agents hired before the schema change get the new questions too.
//
// Usage:
//   node --env-file=.env scripts/add-approval-policy-question.mjs
//
// Idempotent: only appends if approval_policy question is missing.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const NEW_QUESTIONS = [
  {
    id: "approval_policy",
    order: 6,
    type: "choice",
    question: "When should I ask you to approve outbound emails before sending?",
    options: [
      { value: "always", label: "Always ask — I want to review every email before it goes out" },
      { value: "external-only", label: "Only for external recipients (anyone not on my team or a listed contact)" },
      { value: "risk-based", label: "Only for risky messages (high stakes, ambiguous, or hard to reverse)" },
      { value: "never", label: "Never ask — fully autonomous" },
    ],
    default: "external-only",
    memoryKey: "org.approval_policy",
    required: true,
  },
  {
    id: "auto_approve_list",
    order: 7,
    question:
      "Are there any email addresses or domains you'd like me to ALWAYS auto-approve without asking (e.g. trusted vendors, partners)? One per line — use `@domain.com` for whole domains.",
    memoryKey: "org.auto_approve_list",
    required: false,
  },
  {
    id: "require_approval_list",
    order: 8,
    question:
      "Are there any email addresses or domains you'd like me to ALWAYS ask before contacting (overrides auto-approve)? One per line.",
    memoryKey: "org.require_approval_list",
    required: false,
  },
];

async function main() {
  const agents = await prisma.agent.findMany({
    select: { id: true, slug: true, onboardingQuestions: true },
  });

  let updated = 0;
  let skipped = 0;
  for (const agent of agents) {
    const existing = Array.isArray(agent.onboardingQuestions)
      ? agent.onboardingQuestions
      : [];
    const hasPolicy = existing.some(
      (q) => q && typeof q === "object" && q.id === "approval_policy",
    );
    if (hasPolicy) {
      skipped++;
      continue;
    }

    // Determine next order; keep existing questions first.
    const maxOrder = existing.reduce(
      (m, q) =>
        q && typeof q === "object" && typeof q.order === "number"
          ? Math.max(m, q.order)
          : m,
      0,
    );

    const additions = NEW_QUESTIONS.map((q, i) => ({
      ...q,
      order: maxOrder + 1 + i,
    }));

    await prisma.agent.update({
      where: { id: agent.id },
      data: { onboardingQuestions: [...existing, ...additions] },
    });
    updated++;
    console.log(`  updated: ${agent.slug} (${agent.id})`);
  }

  console.log(`\nDone. Updated ${updated} agent(s), skipped ${skipped}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
