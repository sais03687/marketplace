import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { Queue } from "bullmq";
import { getStripe } from "@/lib/stripe";

// The provisioning worker listens on the "provisioning" queue for ALL job types
// (provision, deprovision, pause, resume, update). The old "deprovision" queue
// was never consumed — fixed here.
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
    return jsonError("Agent already fired", 409);
  }

  // Mark as FIRED immediately so no new emails are forwarded
  await prisma.deployment.update({
    where: { id },
    data: { status: "FIRED", firedAt: new Date() },
  });

  // Cancel Stripe subscription at period end (buyer keeps access until then)
  if (deployment.stripeSubscriptionId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        await stripe.subscriptions.update(deployment.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      } catch (err: any) {
        console.error(`[fire] Failed to cancel Stripe subscription ${deployment.stripeSubscriptionId}: ${err.message}`);
      }
    }
  }

  // Enqueue cleanup: stops gateway, deletes AgentMail inbox, deletes GCP service account
  try {
    await getProvisioningQueue().add("deprovision", { type: "deprovision", deploymentId: id });
  } catch (err: any) {
    // Queue unavailable — log clearly; ops team can manually trigger cleanup
    console.error(`[fire] Failed to enqueue deprovision for ${id}: ${err.message}`);
    // Still return success to the client: the DB is already updated
  }

  return jsonSuccess({ message: "Agent fired", deploymentId: id });
}
