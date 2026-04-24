import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { Queue } from "bullmq";

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

  if (deployment.status === "FIRED") {
    return jsonError("Cannot pause/resume a fired agent", 409);
  }
  if (deployment.status === "PROVISIONING") {
    return jsonError("Cannot pause/resume while provisioning is in progress", 409);
  }

  const isPaused = deployment.status === "PAUSED";
  const jobType = isPaused ? "resume" : "pause";
  const newStatus = isPaused ? "ACTIVE" : "PAUSED";

  // Optimistically update DB status so the UI reflects the intent immediately
  await prisma.deployment.update({
    where: { id },
    data: {
      status: newStatus,
      pausedAt: newStatus === "PAUSED" ? new Date() : null,
    },
  });

  // Enqueue the real work: stop/start the gateway process and poller
  try {
    await getProvisioningQueue().add(jobType, { type: jobType, deploymentId: id });
  } catch (err: any) {
    // If queue is unavailable, still return success — DB is already updated.
    // The gateway will be cleaned up on next service restart via recovery logic.
    console.warn(`[pause-route] Failed to enqueue ${jobType} job: ${err.message}`);
  }

  return jsonSuccess({
    message: isPaused ? "Agent resuming" : "Agent pausing",
    status: newStatus,
    deploymentId: id,
  });
}
