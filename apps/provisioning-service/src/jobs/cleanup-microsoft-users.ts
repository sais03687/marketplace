/**
 * Periodic cleanup of orphaned Microsoft 365 users.
 *
 * When provisioning fails after the M365 user is created (e.g., container crash,
 * Agentmail limit exceeded), the user stays in the tenant indefinitely, consuming
 * a license. This job finds deployments that failed/were deprovisioned but still
 * have a workspaceUserId set, deletes those M365 users, and nulls out the field.
 *
 * Scheduled daily alongside renew_ms_webhooks.
 */

import { prisma } from "@marketplace/db";
import { deleteMicrosoftUser } from "../clients/microsoft-workspace.js";

export async function cleanupMicrosoftUsersJob(): Promise<void> {
  // Find deployments where provisioning failed or was deprovisioned but M365 user still exists
  const orphans = await prisma.deployment.findMany({
    where: {
      status: { in: ["ERROR", "FIRED"] },
      workspaceProvider: "MICROSOFT",
      workspaceUserId: { not: null },
    },
    select: { id: true, workspaceUserId: true, workspaceEmail: true },
  });

  if (orphans.length === 0) {
    console.log("[cleanup-ms-users] No orphaned Microsoft users found");
    return;
  }

  console.log(`[cleanup-ms-users] Found ${orphans.length} orphaned Microsoft user(s) to clean up`);

  for (const deployment of orphans) {
    if (!deployment.workspaceUserId) continue;
    try {
      await deleteMicrosoftUser(deployment.workspaceUserId);
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { workspaceUserId: null, workspaceEmail: null },
      });
      console.log(`[cleanup-ms-users] Deleted orphaned M365 user ${deployment.workspaceEmail} (deployment ${deployment.id})`);
    } catch (err: any) {
      console.warn(`[cleanup-ms-users] Failed to delete M365 user for deployment ${deployment.id}: ${err.message}`);
    }
  }
}
