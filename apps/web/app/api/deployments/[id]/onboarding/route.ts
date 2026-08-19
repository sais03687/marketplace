import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";
import { mergeWithPlatformQuestions } from "@/lib/platform-questions";
import { pushApprovalPolicy } from "@/lib/approval-policy";
import { requireDeploymentToken } from "@/lib/deployment-token";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Two kinds of caller: a person in the dashboard with a session, or the
  // agent itself with its deployment token.
  //
  // The agent has to be able to read this, because it is the only one that
  // can. The marketplace runs on Vercel and cannot reach a container, which
  // is why the relay in POST below has never delivered anything, and why
  // these answers have to be pulled by the agent rather than pushed to it.
  const presentsToken = (request.headers.get("authorization") ?? "").startsWith("Bearer ");

  let deployment;
  if (presentsToken) {
    const authed = await requireDeploymentToken(request, id);
    if ("error" in authed) return authed.error;
    deployment = authed.deployment;
  } else {
    const orgResult = await requireOrg();
    if ("error" in orgResult) return orgResult.error;
    const depResult = await requireDeploymentAccess(id, orgResult.company.id);
    if ("error" in depResult) return depResult.error;
    deployment = depResult.deployment;
  }

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

  // Allow submissions from INTERVIEW, OBSERVATION, or LIVE (buyers can update
  // their answers at any time from the Settings page).
  if (
    deployment.onboardingState !== "INTERVIEW" &&
    deployment.onboardingState !== "OBSERVATION" &&
    deployment.onboardingState !== "LIVE"
  ) {
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

  // Store answers. If already LIVE, keep that state — only advance to OBSERVATION
  // from INTERVIEW/OBSERVATION (buyers updating from Settings stay LIVE).
  const nextState =
    deployment.onboardingState === "LIVE" ? "LIVE" : "OBSERVATION";

  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      onboardingData: answers as any,
      autonomyConfig: mergedAutonomyConfig as any,
      onboardingState: nextState,
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
      // Routed through the provisioning service, which can reach the container.
      // Posting containerName from here never worked: it is a localhost address
      // on the VPS and this runs on Vercel. See lib/approval-policy.ts.
      //
      // Onboarding is where the buyer picks their approval policy for the first
      // time, so a silent failure here means an agent starting work under a
      // policy its owner never chose.
      const applied = await pushApprovalPolicy(deployment.containerName, override);
      if (!applied) {
        console.error(
          `[onboarding] ${id}: answers saved, but the approval policy did not reach ` +
            `the running container. It applies at the next provision.`,
        );
      }
    } catch (err) {
      console.error(
        `[onboarding] ${id}: could not push the approval policy:`,
        err instanceof Error ? err.message : err,
      );
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
