import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { deleteInbox } from "../clients/agentmail.js";
import { stopContainer, removeAgentNetwork } from "../clients/docker.js";
import { deleteDeploymentServiceAccount } from "../clients/google-iam.js";
import { deleteGoogleWorkspaceUser } from "../clients/google-workspace.js";
import { deleteAgentIdentity } from "../clients/microsoft-workspace.js";
import { stopMcpSidecars } from "../mcp/sidecar-manager.js";

export async function deprovisionJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: true },
  });

  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }

  console.log(`[deprovision] Starting deprovision for ${deploymentId}`);

  // 1. Stop the agent container (also kills its poller)
  if (deployment.containerName) {
    try {
      const { stopCustomAgent } = await import("./custom-runner.js");
      await stopCustomAgent(deploymentId);
      console.log(`[deprovision] Container stopped: ${deployment.containerName}`);
    } catch (err: any) {
      console.warn(`[deprovision] Failed to stop container: ${err.message}`);
    }
  }

  // 2. Delete AgentMail inbox — only if no other active deployment shares it.
  // Two deployments can end up with the same inbox if the same agent is hired twice
  // by the same company (e.g. after a re-hire). Deleting a shared inbox would break
  // the surviving deployment.
  if (deployment.agentEmailInboxId) {
    const sharedCount = await prisma.deployment.count({
      where: {
        agentEmailInboxId: deployment.agentEmailInboxId,
        id: { not: deploymentId },
        status: { notIn: ["FIRED"] },
      },
    });

    if (sharedCount > 0) {
      console.log(`[deprovision] Inbox ${deployment.agentEmailInboxId} is shared with ${sharedCount} other deployment(s) — skipping delete`);
    } else {
      try {
        await deleteInbox(deployment.agentEmailInboxId);
        console.log(`[deprovision] Deleted inbox ${deployment.agentEmailInboxId} (${deployment.agentEmail})`);
      } catch (err: any) {
        console.warn(`[deprovision] Failed to delete inbox: ${err.message}`);
      }
    }
  }

  // 3. Delete workspace identity or legacy GCP service account (best-effort)
  const workspaceProvider = (deployment as any).workspaceProvider as string | undefined;
  const workspaceUserId = (deployment as any).workspaceUserId as string | undefined;

  if (workspaceProvider === "GOOGLE" && workspaceUserId) {
    try {
      await deleteGoogleWorkspaceUser(workspaceUserId);
      console.log(`[deprovision] Deleted Google Workspace user: ${workspaceUserId}`);
    } catch (err: any) {
      console.warn(`[deprovision] Failed to delete Google Workspace user: ${err.message}`);
    }
  } else if (workspaceProvider === "MICROSOFT" && workspaceUserId) {
    // Scope the delete to the tenant the identity actually lives in. Using the
    // platform Graph client here only worked because platform and buyer tenant are
    // the same during testing — against a real buyer it would 404 and silently
    // leave them paying for a fired agent.
    const buyerTenantId = (deployment as any).buyerMicrosoftTenantId as string | null;
    try {
      await deleteAgentIdentity(buyerTenantId ?? null, workspaceUserId);
      // Clear the pointers so the nightly reconciliation job doesn't retry a
      // deletion that already succeeded.
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { workspaceUserId: null, workspaceEmail: null },
      });
      console.log(`[deprovision] Deleted Microsoft 365 identity and released its seat: ${workspaceUserId}`);
    } catch (err: any) {
      // Left in place deliberately: the nightly cleanup job re-reads FIRED
      // deployments that still have a workspaceUserId and will try again.
      console.warn(
        `[deprovision] Failed to delete Microsoft 365 user ${workspaceUserId}: ${err.message}. ` +
          `Its seat is still consumed; the nightly cleanup job will retry.`,
      );
    }
  } else {
    // Legacy path: delete per-deployment GCP IAM service account
    const iamKey = config.gcpIamKey || config.googleServiceAccountKey;
    if ((deployment as any).deploymentServiceAccountEmail && config.gcpProjectId && iamKey) {
      try {
        await deleteDeploymentServiceAccount(
          (deployment as any).deploymentServiceAccountEmail,
          config.gcpProjectId,
          iamKey,
        );
        console.log(`[deprovision] Deleted legacy service account: ${(deployment as any).deploymentServiceAccountEmail}`);
      } catch (err: any) {
        console.warn(`[deprovision] Failed to delete service account: ${err.message}`);
      }
    }
  }

  // 3b. Clean up MCP sidecars and isolated network
  try {
    await stopMcpSidecars(deploymentId);
  } catch (err: any) {
    console.warn(`[deprovision] MCP sidecar cleanup failed: ${err.message}`);
  }
  try {
    await removeAgentNetwork(deploymentId);
  } catch (err: any) {
    console.warn(`[deprovision] Network cleanup failed: ${err.message}`);
  }

  // 4. Update deployment status
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "FIRED", firedAt: new Date() },
  });

  // 5. Log
  await prisma.provisioningLog.create({
    data: {
      deploymentId,
      step: "deprovision_complete",
      status: "succeeded",
      attempt: 1,
    },
  });

  console.log(`[deprovision] Deployment ${deploymentId} deprovisioned`);
}
