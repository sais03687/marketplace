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

  // The agent introduces itself with what it can actually do *here*.
  //
  // The capability list is the creator's advertisement for the agent, written
  // for the org tier. On the email tier the platform withholds every drive and
  // workspace action, so sending that list unfiltered had a new hire open by
  // promising SharePoint and shared links it would then refuse — the worst
  // possible first impression, and a promise the buyer had no way to check
  // until they asked for one of those things.
  const emailTier = deployment.workspaceScope === "platform";
  const WORKSPACE_WORDS =
    /\b(sharepoint|onedrive|google drive|\bdrive\b|excel|spreadsheet on|share[sd]? (?:a |the )?link|workspace|file server)\b/i;
  const capabilities = (agent?.capabilities ?? []).filter(
    (c) => !emailTier || !WORKSPACE_WORDS.test(`${c.name} ${c.description}`),
  );

  // Send introduction email from the agent's own inbox
  if (deployment.managerEmail && deployment.agentEmail) {
    const { subject, html } = buildIntroductionEmail({
      agentName: deployment.agentName,
      agentEmail: deployment.agentEmail,
      capabilities,
      // Same reason: "share your Drive files with this address" is an offer the
      // email tier cannot honour, since drive actions are withheld there.
      googleServiceAccountEmail: emailTier
        ? undefined
        : ((deployment as any).deploymentServiceAccountEmail ?? undefined),
    });

    await sendNotificationEmail({
      deploymentId: deployment.id,
      agentEmail: (deployment as any).workspaceEmail,
      inboxId: deployment.agentEmailInboxId,
      to: deployment.managerEmail,
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
