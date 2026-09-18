/**
 * Platform-level onboarding questions injected into every agent's hire wizard
 * and post-hire onboarding interview. These represent non-negotiable platform
 * controls that cannot be omitted by creators.
 *
 * Keep in sync with the server-side copy in:
 *   apps/web/app/api/deployments/[id]/onboarding/route.ts
 */

export interface OnboardingQuestion {
  id: string;
  order?: number;
  question: string;
  memoryKey: string;
  required: boolean;
  type?: "text" | "choice";
  options?: Array<{ value: string; label: string }>;
  default?: string;
  /**
   * Which hire tiers this question applies to. Omitted means both, so every
   * existing package keeps working untouched.
   *
   * Mirrors OnboardingQuestion in @marketplace/agent-package-schema, which is
   * what a creator's questions.json is validated against.
   */
  tiers?: Array<"platform" | "buyer_org">;
}

export const PLATFORM_QUESTIONS: OnboardingQuestion[] = [
  {
    id: "approval_policy",
    type: "choice",
    question:
      "When should I ask you to approve outbound emails before sending? (We recommend starting with 'Always ask' for your first few days so you can see exactly how I work before giving me more autonomy.)",
    options: [
      {
        value: "always",
        label: "Always ask — review every email before it goes out (recommended to start)",
      },
      {
        value: "external-only",
        label:
          "Only for external recipients (anyone not on my team or a listed contact)",
      },
      {
        value: "risk-based",
        label:
          "Only for risky messages (high stakes, ambiguous, or hard to reverse)",
      },
      { value: "never", label: "Never ask — fully autonomous" },
    ],
    default: "always",
    memoryKey: "org.approval_policy",
    required: true,
  },
  {
    id: "auto_approve_list",
    question:
      "Are there any email addresses or domains you'd like me to ALWAYS auto-approve without asking (e.g. trusted vendors, partners)? One per line — use `@domain.com` for whole domains.",
    memoryKey: "org.auto_approve_list",
    required: false,
  },
  {
    id: "require_approval_list",
    question:
      "Are there any email addresses or domains you'd like me to ALWAYS ask before contacting (overrides auto-approve)? One per line.",
    memoryKey: "org.require_approval_list",
    required: false,
  },
  {
    id: "agentmind_enabled",
    type: "choice",
    question:
      "Should your agent participate in AgentMind — a shared knowledge base where agents learn from each other's corrections? (Agents that opt out cannot access shared knowledge either.)",
    options: [
      {
        value: "yes",
        label: "Yes — contribute and access shared knowledge (recommended)",
      },
      {
        value: "no_auto",
        label: "Yes, but I want to review each contribution before it's shared",
      },
      { value: "no", label: "No — opt out entirely" },
    ],
    default: "yes",
    memoryKey: "org.agentmind_enabled",
    required: true,
  },
];

/**
 * Merge agent-specific questions with platform questions.
 * Platform questions are appended only if not already declared by the agent.
 */
export function mergeWithPlatformQuestions(
  agentQuestions: unknown,
  /**
   * The hire tier, so questions that presuppose a connected workspace are not
   * asked of a buyer who has none.
   *
   * The first real email-tier hire (2026-09-18) was asked "How is your
   * SharePoint organized?" — a tier where every drive tool is withheld.
   * Answering it is wasted effort, and being asked implies a capability the
   * agent does not have.
   *
   * Filtered here rather than left to creator guidance, because a question a
   * creator was merely advised not to ask still gets asked. Omitting `tiers`
   * means "both", so every existing package keeps working untouched.
   */
  mailboxLocation: "platform" | "buyer_org" = "buyer_org",
): OnboardingQuestion[] {
  const appliesHere = (q: OnboardingQuestion) =>
    !Array.isArray(q.tiers) || q.tiers.length === 0 || q.tiers.includes(mailboxLocation);

  const existing: OnboardingQuestion[] = (
    Array.isArray(agentQuestions) ? (agentQuestions as OnboardingQuestion[]) : []
  ).filter(appliesHere);

  const existingIds = new Set(existing.map((q) => q.id));

  const maxOrder = existing.reduce((m, q) => {
    return typeof q.order === "number" ? Math.max(m, q.order) : m;
  }, 0);

  const additions = PLATFORM_QUESTIONS.filter(
    (q) => !existingIds.has(q.id) && appliesHere(q),
  ).map((q, i) => ({ ...q, order: maxOrder + 1 + i }));

  return [...existing, ...additions];
}
