import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";

// Platform-level questions injected into every agent's onboarding interview
// regardless of whether the uploader included them in their questions.json.
// These are treated as a platform guarantee — they cannot be stripped or
// forgotten by creators.
const PLATFORM_QUESTIONS = [
  {
    id: "approval_policy",
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
      "Should your agent participate in AgentMind \u2014 a shared knowledge base where agents learn from each other's corrections? (Agents that opt out cannot access shared knowledge either.)",
    options: [
      { value: "yes", label: "Yes \u2014 contribute and access shared knowledge (recommended)" },
      { value: "no_auto", label: "Yes, but I want to review each contribution before it's shared" },
      { value: "no", label: "No \u2014 opt out entirely" },
    ],
    default: "yes",
    memoryKey: "org.agentmind_enabled",
    required: true,
  },
];

function mergePlatformQuestions(
  agentQuestions: unknown,
  _runtime: string | null | undefined,
): unknown[] {
  const existing = Array.isArray(agentQuestions) ? [...agentQuestions] : [];

  // Both CUSTOM and OPENCLAW runtimes now honor the approval policy:
  //   - CUSTOM: adapter.py enforces deterministically in the send wrapper.
  //   - OPENCLAW: provision.ts renders APPROVAL_POLICY_SECTION and appends
  //     it to /agent/workspace/AGENTS.md at container startup, so the LLM
  //     reads the hired manager's configured policy at every session.
  // Same onboarding questions, same settings UI, same source of truth.

  const existingIds = new Set(
    existing
      .filter((q): q is { id: string } => !!q && typeof q === "object" && "id" in q)
      .map((q) => q.id),
  );

  // Append only platform questions that the agent doesn't already declare
  const maxOrder = existing.reduce((m, q) => {
    if (q && typeof q === "object" && "order" in q && typeof q.order === "number") {
      return Math.max(m, q.order);
    }
    return m;
  }, 0);

  const additions = PLATFORM_QUESTIONS.filter((q) => !existingIds.has(q.id)).map(
    (q, i) => ({ ...q, order: maxOrder + 1 + i }),
  );

  return [...existing, ...additions];
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  // Get questions from agent (include runtime so we can skip platform
  // question injection for runtimes that don't support them).
  const agent = await prisma.agent.findUnique({
    where: { id: deployment.agentId },
    select: { onboardingQuestions: true, runtime: true },
  });

  return jsonSuccess({
    onboardingState: deployment.onboardingState,
    onboardingData: deployment.onboardingData,
    // Merge platform questions (only for supported runtimes).
    questions: mergePlatformQuestions(agent?.onboardingQuestions, agent?.runtime),
    status: deployment.status,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  if (deployment.onboardingState !== "INTERVIEW") {
    return jsonError("Onboarding is not in INTERVIEW stage", 409);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const { answers } = body as { answers?: Record<string, string> };
  if (!answers || typeof answers !== "object") {
    return jsonError("answers object required", 400);
  }

  // Extract approval-policy answers and fold them into autonomyConfig so
  // provision.ts (on re-provision) and the runtime adapter (hot-reload via
  // /internal/approval-policy) can apply them.
  const toList = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    if (typeof v === "string") {
      return v
        .split(/[\n,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  };

  const a = answers as Record<string, unknown>;
  const autonomyPatch: Record<string, unknown> = {};
  if (typeof a.approval_policy === "string" && a.approval_policy.trim()) {
    autonomyPatch.approvalPolicy = a.approval_policy.trim();
  }
  if (a.approval_risk_threshold != null) {
    const n = Number(a.approval_risk_threshold);
    if (!Number.isNaN(n)) autonomyPatch.approvalRiskThreshold = n;
  }
  const autoList = toList(a.auto_approve_list);
  if (autoList.length) autonomyPatch.autoApproveList = autoList;
  const reqList = toList(a.require_approval_list);
  if (reqList.length) autonomyPatch.requireApprovalList = reqList;

  if (typeof a.agentmind_enabled === "string") {
    if (a.agentmind_enabled === "no") {
      autonomyPatch.agentMindEnabled = false;
      autonomyPatch.agentMindAutoApprove = false;
    } else if (a.agentmind_enabled === "no_auto") {
      autonomyPatch.agentMindEnabled = true;
      autonomyPatch.agentMindAutoApprove = false;
    } else {
      // "yes" (default)
      autonomyPatch.agentMindEnabled = true;
      autonomyPatch.agentMindAutoApprove = true;
    }
  }

  const mergedAutonomyConfig = {
    ...((deployment.autonomyConfig as Record<string, unknown>) ?? {}),
    ...autonomyPatch,
  };

  // Store answers and advance to OBSERVATION
  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      onboardingData: answers as any,
      autonomyConfig: mergedAutonomyConfig as any,
      onboardingState: "OBSERVATION",
    },
  });

  // Hot-reload approval policy into the running container (best-effort).
  // The adapter re-reads /agent/approval_policy.json on every call, so this
  // takes effect immediately for the current container without re-provision.
  if (deployment.containerName && Object.keys(autonomyPatch).length > 0) {
    try {
      const override: Record<string, unknown> = {
        policy: autonomyPatch.approvalPolicy ?? "external-only",
      };
      if (typeof autonomyPatch.approvalRiskThreshold === "number") {
        override.riskThreshold = autonomyPatch.approvalRiskThreshold;
      }
      if (Array.isArray(autonomyPatch.autoApproveList)) {
        override.autoApprove = autonomyPatch.autoApproveList;
      }
      if (Array.isArray(autonomyPatch.requireApprovalList)) {
        override.requireApproval = autonomyPatch.requireApprovalList;
      }
      const baseUrl = deployment.containerName.startsWith("http")
        ? deployment.containerName
        : `http://${deployment.containerName}:4100`;
      await fetch(`${baseUrl}/internal/approval-policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(override),
      }).catch(() => {});
    } catch {
      // best-effort; policy will take effect on next provision
    }
  }

  // Relay answers to agent container (fire-and-forget)
  if (deployment.containerName) {
    const questionsText = Object.entries(answers)
      .map(([key, value]) => `Q: ${key}\nA: ${value}`)
      .join("\n\n");

    const message = [
      "Your hiring manager has answered your onboarding questions. Here are their responses:",
      "",
      questionsText,
      "",
      "Please review these answers and use them to configure your knowledge base.",
      "Store the key information in your memory for future reference.",
    ].join("\n");

    try {
      const containerUrl = deployment.containerName.startsWith("http")
        ? deployment.containerName
        : `http://${deployment.containerName}:4100`;

      await fetch(`${containerUrl}/hooks/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          name: "Onboarding Answers",
          wakeMode: "now",
          deliver: false,
          sessionKey: "hook:onboarding-answers",
        }),
      });
    } catch {
      // Container may be unreachable — answers are saved in DB
    }
  }

  return jsonSuccess({
    onboardingState: updated.onboardingState,
    onboardingData: updated.onboardingData,
  });
}
