import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { tokensMatch } from "@/lib/constant-time";

/**
 * Provisioning could not give this buyer a working agent.
 *
 * Called by the provisioning service, which holds PROVISIONING_SECRET and no
 * Stripe key — billing lives here. Two things have to happen, and until
 * 2026-09-24 neither did: the buyer has to be told, and they must not be
 * charged for an agent that was never built.
 *
 * The subscription is cancelled at period end rather than immediately. During
 * the trial that means it lapses before the first invoice, so nothing is ever
 * billed — and it leaves the subscription in place, so a retry can resume it
 * instead of sending the buyer through checkout a second time. Cancelling
 * outright would force a second subscription, which is how one broken hire
 * became two charges.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const secret = process.env.PROVISIONING_SECRET ?? "";
  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || !presented || !tokensMatch(presented, secret)) {
    return jsonError("Unauthorized", 401);
  }

  const body = await request.json().catch(() => ({}) as Record<string, unknown>);
  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 500) : "Provisioning failed";

  const deployment = await prisma.deployment.findUnique({ where: { id } });
  if (!deployment) return jsonError("Deployment not found", 404);

  await prisma.deployment.update({ where: { id }, data: { status: "ERROR" } });

  // The reason goes in ProvisioningLog, which already records every step and is
  // what the dashboard reads to tell the buyer what went wrong. No new column:
  // this is the table that exists for exactly this.
  await prisma.provisioningLog.create({
    data: { deploymentId: id, step: "provision", status: "failed", message: reason },
  });

  let billing = "no subscription to stop";
  const subscriptionId = (deployment as { stripeSubscriptionId?: string | null }).stripeSubscriptionId;
  if (subscriptionId) {
    try {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured on this deployment");
      const sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      billing =
        sub.status === "trialing"
          ? "subscription ends with the trial — the buyer will not be charged"
          : "subscription set to cancel at period end";
    } catch (err) {
      // Never let a billing problem hide the provisioning failure: the buyer
      // still needs to see that their agent did not come up.
      console.error(`[provisioning-failed] could not stop billing for ${id}:`, err);
      billing = "could not stop billing — needs a look in Stripe";
    }
  }

  console.warn(`[provisioning-failed] ${id}: ${reason} (${billing})`);
  return jsonSuccess({ status: "ERROR", billing });
}
