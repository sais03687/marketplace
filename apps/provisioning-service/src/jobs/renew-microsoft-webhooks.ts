import { prisma } from "@marketplace/db";
import { renewMicrosoftWebhook } from "../clients/microsoft-workspace.js";

export async function renewMicrosoftWebhooksJob(): Promise<void> {
  // Find all active Microsoft deployments with a Graph subscription
  const deployments = await prisma.deployment.findMany({
    where: {
      status: "ACTIVE",
      workspaceProvider: "MICROSOFT",
      msGraphSubId: { not: null },
    },
    select: { id: true, msGraphSubId: true },
  });

  console.log(`[renew-ms-webhooks] Found ${deployments.length} Microsoft deployment(s) to check`);

  for (const deployment of deployments) {
    if (!deployment.msGraphSubId) continue;
    try {
      const newExpiry = await renewMicrosoftWebhook(deployment.msGraphSubId);
      console.log(`[renew-ms-webhooks] Renewed subscription for deployment ${deployment.id}, expires ${newExpiry.toISOString()}`);
    } catch (err: any) {
      console.warn(`[renew-ms-webhooks] Failed to renew subscription for deployment ${deployment.id}: ${err.message}`);
    }
  }
}
