import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";
import {
  sendNotificationEmail,
  buildIntroductionEmail,
} from "@/lib/email";

const TRANSITIONS: Record<string, string> = {
  OBSERVATION: "INTRODUCTION",
  INTRODUCTION: "LIVE",
};

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

  const currentState = deployment.onboardingState;
  const nextState = TRANSITIONS[currentState];

  if (!nextState) {
    return jsonError(
      `Cannot advance from ${currentState}. Only OBSERVATION and INTRODUCTION can be advanced.`,
      409,
    );
  }

  if (nextState === "LIVE") {
    // Advancing to LIVE means deployment goes ACTIVE
    const updated = await prisma.deployment.update({
      where: { id },
      data: {
        onboardingState: "LIVE",
        status: "ACTIVE",
      },
    });

    return jsonSuccess({
      onboardingState: updated.onboardingState,
      status: updated.status,
    });
  }

  // Advancing to INTRODUCTION — platform sends the intro email directly
  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      onboardingState: nextState as any,
    },
  });

  // Fetch agent capabilities for the intro email
  const agent = await prisma.agent.findUnique({
    where: { id: deployment.agentId },
    include: { capabilities: { select: { name: true, description: true } } },
  });

  // Platform sends the intro email on behalf of the agent.
  // This is enforced regardless of agent architecture (OpenClaw, custom, etc.)
  if (deployment.weeklyDigestEmail && deployment.agentEmail) {
    const { subject, html } = buildIntroductionEmail({
      agentName: deployment.agentName,
      agentEmail: deployment.agentEmail,
      capabilities: agent?.capabilities ?? [],
    });

    // Send from the agent's own inbox so it looks like it came from the agent
    await sendNotificationEmail({
      inboxId: deployment.agentEmailInboxId,
      to: deployment.weeklyDigestEmail,
      subject,
      html,
    });
  }

  // Also notify the agent container so it can prepare (optional, best-effort)
  if (deployment.containerName) {
    try {
      const containerUrl = deployment.containerName.startsWith("http")
        ? deployment.containerName
        : `http://${deployment.containerName}:4100`;

      await fetch(`${containerUrl}/hooks/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "You have been introduced to the team. Your intro email was sent by the platform. Wait for the buyer to reach out with their first task.",
          name: "Introduction",
          wakeMode: "now",
          deliver: false,
          sessionKey: "hook:introduction",
        }),
      });
    } catch {
      // Container may be unreachable — non-fatal
    }
  }

  return jsonSuccess({
    onboardingState: updated.onboardingState,
    status: updated.status,
  });
}
