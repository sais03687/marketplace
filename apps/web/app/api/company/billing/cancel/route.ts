import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, parseBody } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";

const cancelSchema = z.object({
  subscriptionId: z.string().min(1),
});

export async function POST(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const parsed = await parseBody(request, cancelSchema);
  if ("error" in parsed) return parsed.error;
  const { subscriptionId } = parsed.data;

  // Verify this subscription belongs to this company
  const deployment = await prisma.deployment.findFirst({
    where: { companyId: company.id, stripeSubscriptionId: subscriptionId },
  });

  if (!deployment) {
    return jsonError("Subscription not found", 404);
  }

  const stripe = getStripe();
  if (!stripe) return jsonError("Stripe is not configured", 503);
  await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

  return jsonSuccess({ cancelled: true });
}
