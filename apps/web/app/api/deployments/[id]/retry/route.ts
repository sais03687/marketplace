import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { getProvisioningQueue } from "@/lib/provisioning-queue";

/**
 * Run provisioning again for a hire that failed.
 *
 * Before this existed, the only way out of a failed hire was to fire the agent
 * and hire it again — a second subscription, and so a second charge, for one
 * agent that had never worked. The provisioning job guards on
 * status === PROVISIONING and nothing ever moved a deployment back, so a failed
 * hire could not be retried at all.
 *
 * This resumes the existing subscription rather than creating one: a failure
 * marks it to cancel at period end, and a retry clears that mark. No checkout,
 * no new charge.
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

  if (deployment.status === "FIRED") {
    return jsonError("This agent was fired. Hire it again to start over.", 409);
  }
  if (deployment.status === "PROVISIONING") {
    return jsonError("Setup is already running.", 409);
  }
  // A working deployment is not retried into a rebuild by accident: ACTIVE and
  // ONBOARDING agents have a container and a mailbox someone may be using.
  if (deployment.status !== "ERROR") {
    return jsonError(
      `Only a failed setup can be retried — this agent is ${deployment.status}.`,
      409,
    );
  }

  // Put billing back the way it was before the failure, so the retry runs on
  // the subscription the buyer already has.
  let billing = "no subscription to resume";
  if (deployment.stripeSubscriptionId) {
    try {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured on this deployment");
      const sub = await stripe.subscriptions.retrieve(deployment.stripeSubscriptionId);
      if (sub.status === "canceled") {
        return jsonError(
          "The subscription for this hire has already ended. Hire the agent again — " +
            "you were not charged for the failed setup.",
          409,
        );
      }
      if (sub.cancel_at_period_end) {
        await stripe.subscriptions.update(deployment.stripeSubscriptionId, {
          cancel_at_period_end: false,
        });
      }
      billing = sub.status === "trialing" ? "still in trial — nothing billed yet" : "subscription resumed";
    } catch (err) {
      console.error(`[retry] could not resume billing for ${id}:`, err);
      return jsonError(
        "Could not resume the subscription for this hire, so setup was not retried. " +
          "This needs a look in Stripe before trying again.",
        502,
      );
    }
  }

  // The job guards on PROVISIONING, which is what makes a retry a retry rather
  // than a second hire.
  await prisma.deployment.update({ where: { id }, data: { status: "PROVISIONING" } });

  try {
    await getProvisioningQueue().add("provision", {
      type: "provision",
      deploymentId: id,
      // What it was before this route moved it, so the job knows this is a
      // failed hire being rebuilt rather than a live agent being re-provisioned.
      statusBefore: deployment.status,
    });
  } catch (err) {
    // Put it back, or the deployment sits in PROVISIONING with no job coming
    // and the retry button refuses to run again.
    await prisma.deployment.update({ where: { id }, data: { status: "ERROR" } });
    console.error(`[retry] could not enqueue provisioning for ${id}:`, err);
    return jsonError("Could not start setup. Try again in a moment.", 503);
  }

  console.log(`[retry] re-provisioning ${id} (${billing})`);
  return jsonSuccess({ status: "PROVISIONING", billing });
}
