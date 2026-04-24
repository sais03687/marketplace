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

/**
 * POST /api/deployments/[id]/onboarding/advance
 *
 * Single-step activation: sends the introduction email from the agent's inbox
 * and immediately sets the deployment ACTIVE. Called once by the onboarding
 * panel "Activate Agent" button.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  if (deployment.status !== "ONBOARDING") {
    return jsonError("Deployment is not in the onboarding state", 409);
  }

  // Fetch agent capabilities for the intro email
  const agent = await prisma.agent.findUnique({
    where: { id: deployment.agentId },
    include: { capabilities: { select: { name: true, description: true } } },
  });

  // Send introduction email from the agent's own inbox
  if (deployment.weeklyDigestEmail && deployment.agentEmail) {
    const { subject, html } = buildIntroductionEmail({
      agentName: deployment.agentName,
      agentEmail: deployment.agentEmail,
      capabilities: agent?.capabilities ?? [],
      googleServiceAccountEmail:
        (deployment as any).deploymentServiceAccountEmail ?? undefined,
    });

    await sendNotificationEmail({
      inboxId: deployment.agentEmailInboxId,
      to: deployment.weeklyDigestEmail,
      subject,
      html,
    });
  }

  // Notify the agent container (best-effort)
  if (deployment.containerName) {
    try {
      const containerUrl = deployment.containerName.startsWith("http")
        ? deployment.containerName
        : `http://${deployment.containerName}:4100`;

      await fetch(`${containerUrl}/hooks/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message:
            "Your introduction email has been sent. You are now live — begin operating according to your approval policy.",
          name: "Activation",
          wakeMode: "now",
          deliver: false,
          sessionKey: "hook:activation",
        }),
      });
    } catch {
      // Container may be unreachable — non-fatal
    }
  }

  // Activate the deployment
  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      status: "ACTIVE",
      onboardingState: "LIVE",
    },
  });

  return jsonSuccess({
    status: updated.status,
    onboardingState: updated.onboardingState,
  });
}
