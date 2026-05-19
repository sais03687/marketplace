import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { Queue } from "bullmq";
import { del, list } from "@vercel/blob";

let provisioningQueue: Queue | null = null;
function getProvisioningQueue() {
  if (!provisioningQueue) {
    provisioningQueue = new Queue("provisioning", {
      connection: {
        host: new URL(process.env.REDIS_URL || "redis://localhost:6379").hostname,
        port: parseInt(
          new URL(process.env.REDIS_URL || "redis://localhost:6379").port || "6379",
          10,
        ),
      },
    });
  }
  return provisioningQueue;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const agent = await prisma.agent.findUnique({
    where: { slug },
    include: {
      capabilities: true,
      creator: {
        select: { displayName: true, email: true },
      },
      reviews: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  return jsonSuccess(agent);
}

/**
 * DELETE /api/agents/[slug]
 * Suspends the agent: pauses all active deployments, cancels Stripe billing,
 * deletes all version files from blob storage, and removes AgentVersion records.
 * The Agent record itself is kept (SUSPENDED) to preserve deployment history.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });
  if (!creator) return jsonError("Creator not found", 404);

  const agent = await prisma.agent.findUnique({
    where: { slug },
    include: { versions: true },
  });
  if (!agent) return jsonError("Agent not found", 404);
  if (agent.creatorId !== creator.id) return jsonError("Not authorized", 403);

  const queue = getProvisioningQueue();
  const stripe = getStripe();
  const PAUSE_REASON = "Agent removed by creator. All deployments have been paused.";

  // Pause all active deployments
  const activeDeployments = await prisma.deployment.findMany({
    where: {
      agentId: agent.id,
      status: { in: ["ACTIVE", "ONBOARDING", "PROVISIONING"] },
    },
  });

  await Promise.all(
    activeDeployments.map(async (dep) => {
      await prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: "PAUSED",
          pausedAt: new Date(),
          pauseReason: PAUSE_REASON,
        },
      });

      try {
        await queue.add("pause", { type: "pause", deploymentId: dep.id });
      } catch (err: any) {
        console.warn(`[delete-agent] Failed to enqueue pause for ${dep.id}:`, err.message);
      }

      if (dep.stripeSubscriptionId && stripe) {
        try {
          await stripe.subscriptions.update(dep.stripeSubscriptionId, {
            pause_collection: { behavior: "void" },
          });
        } catch (err: any) {
          console.warn(`[delete-agent] Stripe pause failed for ${dep.stripeSubscriptionId}:`, err.message);
        }
      }
    }),
  );

  // Delete blob files for every version
  for (const v of agent.versions) {
    if (v.storagePath) {
      try {
        const { blobs } = await list({ prefix: v.storagePath });
        if (blobs.length > 0) {
          await del(blobs.map((b) => b.url));
        }
      } catch (err: any) {
        console.warn(`[delete-agent] Blob cleanup failed for version ${v.id}:`, err.message);
      }
    }
  }

  // Delete capabilities and versions, then suspend agent
  await prisma.$transaction([
    prisma.capability.deleteMany({ where: { agentId: agent.id } }),
    prisma.agentVersion.deleteMany({ where: { agentId: agent.id } }),
    prisma.agent.update({
      where: { id: agent.id },
      data: {
        status: "SUSPENDED",
        currentVersion: null,
      },
    }),
  ]);

  return jsonSuccess({
    message: "Agent suspended and all versions removed",
    pausedDeployments: activeDeployments.length,
  });
}
