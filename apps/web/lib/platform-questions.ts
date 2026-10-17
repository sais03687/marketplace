/**
 * Platform-level onboarding questions injected into every agent's hire wizard
 * and post-hire onboarding interview. These represent non-negotiable platform
 * controls that cannot be omitted by creators.
 *
 * The onboarding route imports this list (mergeWithPlatformQuestions); there
 * is no second copy to keep in sync.
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
      "When should I check with you before sending an email? We suggest starting with 'Ask me before it sends anything' so you can see how I work. You can change this any time.",
    // "risk-based" is still accepted from agents set that way, but no longer
    // offered: three plain choices cover what buyers pick.
    options: [
      {
        value: "always",
        label: "Ask me before it sends anything (recommended to start)",
      },
      {
        value: "external-only",
        label: "Ask me only for people outside my company",
      },
      { value: "never", label: "Never ask — it sends on its own" },
    ],
    default: "always",
    memoryKey: "org.approval_policy",
    required: true,
  },
  {
    id: "auto_approve_list",
    question:
      "Optional: anyone I can always email without asking you (e.g. trusted suppliers)? One per line — use `@domain.com` for a whole company.",
    memoryKey: "org.auto_approve_list",
    required: false,
  },
  {
    id: "require_approval_list",
    question:
      "Optional: anyone I must always ask you about before emailing? One per line.",
    memoryKey: "org.require_approval_list",
    required: false,
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
