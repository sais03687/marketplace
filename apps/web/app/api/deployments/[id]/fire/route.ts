import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { Queue } from "bullmq";

let deprovisionQueue: Queue | null = null;
function getDeprovisionQueue() {
  if (!deprovisionQueue) {
    deprovisionQueue = new Queue("deprovision", {
      connection: {
        host: new URL(process.env.REDIS_URL || "redis://localhost:6379").hostname,
        port: parseInt(
          new URL(process.env.REDIS_URL || "redis://localhost:6379").port || "6379",
          10,
        ),
      },
    });
  }
  return deprovisionQueue;
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
    return jsonError("Agent already fired", 409);
  }

  await prisma.deployment.update({
    where: { id },
    data: {
      status: "FIRED",
      firedAt: new Date(),
    },
  });

  try {
    await getDeprovisionQueue().add("deprovision", { deploymentId: id });
  } catch {
    // Queue may not be available
  }

  return jsonSuccess({ message: "Agent fired", deploymentId: id });
}
