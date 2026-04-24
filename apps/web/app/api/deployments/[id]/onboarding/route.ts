import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";
import { mergeWithPlatformQuestions } from "@/lib/platform-questions";

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
    questions: mergeWithPlatformQuestions(agent?.onboardingQuestions),
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

  // Allow submissions from INTERVIEW (post-hire onboarding) or OBSERVATION
  // (re-submission to update answers already given during the hire wizard).
  if (deployment.onboardingState !== "INTERVIEW" && deployment.onboardingState !== "OBSERVATION") {
    return jsonError("Onboarding is past the setup stage", 409);
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
