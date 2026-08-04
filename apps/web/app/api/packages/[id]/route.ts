import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { del, list } from "@vercel/blob";
import { getProvisioningQueue } from "@/lib/provisioning-queue";


/**
 * DELETE /api/packages/[id]
 * Deletes a specific agent version. If any active deployments are running
 * on this version, they are paused and Stripe subscriptions are suspended.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });
  if (!creator) return jsonError("Creator not found", 404);

  const version = await prisma.agentVersion.findUnique({
    where: { id },
    include: { agent: true },
  });
  if (!version) return jsonError("Version not found", 404);
  if (version.agent.creatorId !== creator.id)
    return jsonError("Not authorized", 403);

  if (version.vetStatus === "PENDING") {
    return jsonError(
      "Cannot delete a version that is currently under review. Wait for the vetting decision first.",
      409,
    );
  }

  const queue = getProvisioningQueue();
  const stripe = getStripe();
  const PAUSE_REASON = "Agent version removed by creator. A new version will resume service automatically.";

  // Find active deployments on this agent running this specific version
  const activeDeployments = await prisma.deployment.findMany({
    where: {
      agentId: version.agentId,
      agentVersion: version.version,
      status: { in: ["ACTIVE", "ONBOARDING", "PROVISIONING"] },
    },
  });

  // Pause each deployment
  await Promise.all(
    activeDeployments.map(async (dep) => {
      // Update DB status
      await prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: "PAUSED",
          pausedAt: new Date(),
          pauseReason: PAUSE_REASON,
        },
      });

      // Enqueue pause job (non-fatal if queue unavailable)
      try {
        await queue.add("pause", { type: "pause", deploymentId: dep.id });
      } catch (err: any) {
        console.warn(`[delete-version] Failed to enqueue pause for ${dep.id}:`, err.message);
      }

      // Pause Stripe subscription (pause_collection so billing stops but sub survives for resume)
      if (dep.stripeSubscriptionId && stripe) {
        try {
          await stripe.subscriptions.update(dep.stripeSubscriptionId, {
            pause_collection: { behavior: "void" },
          });
        } catch (err: any) {
          console.warn(`[delete-version] Stripe pause failed for ${dep.stripeSubscriptionId}:`, err.message);
        }
      }
    }),
  );

  // Remove blob files for this version
  if (version.storagePath) {
    try {
      const { blobs } = await list({ prefix: version.storagePath });
      if (blobs.length > 0) {
        await del(blobs.map((b) => b.url));
      }
    } catch (err: any) {
      console.warn(`[delete-version] Blob cleanup failed:`, err.message);
    }
  }

  // Update agent.currentVersion if this was the live version
  if (version.agent.currentVersion === version.version) {
    // Find the most recently approved other version
    const latestOther = await prisma.agentVersion.findFirst({
      where: {
        agentId: version.agentId,
        id: { not: id },
        vetStatus: { in: ["MANUALLY_APPROVED", "PASSED"] },
      },
      orderBy: { publishedAt: "desc" },
    });

    await prisma.agent.update({
      where: { id: version.agentId },
      data: {
        currentVersion: latestOther?.version ?? null,
        status: latestOther ? "LIVE" : "IN_REVIEW",
      },
    });
  }

  // Delete the version record
  await prisma.agentVersion.delete({ where: { id } });

  return jsonSuccess({
    message: "Version deleted",
    pausedDeployments: activeDeployments.length,
  });
}
