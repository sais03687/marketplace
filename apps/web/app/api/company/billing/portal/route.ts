import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";

export async function POST(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  if (!company.stripeCustomerId) {
    return jsonError("No billing account found", 404);
  }

  const stripe = getStripe();
  if (!stripe) return jsonError("Stripe is not configured", 503);

  const origin = request.headers.get("origin") ?? "https://marketplace-web-gamma-two.vercel.app";

  const session = await stripe.billingPortal.sessions.create({
    customer: company.stripeCustomerId,
    return_url: `${origin}/dashboard/billing`,
  });

  return jsonSuccess({ url: session.url });
}
