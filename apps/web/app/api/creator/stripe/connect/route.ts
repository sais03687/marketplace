/**
 * Stripe Connect Express onboarding for creators.
 *
 * GET  — returns the creator's current Connect status
 * POST — creates a Stripe Express account (if needed) and returns an onboarding URL
 *
 * After the creator completes onboarding, Stripe redirects them to
 * /api/creator/stripe/return which marks stripeOnboarded = true.
 */
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002";
const PLATFORM_REVENUE_SHARE = parseFloat(process.env.PLATFORM_REVENUE_SHARE || "0.30");
const CREATOR_SHARE = Math.round((1 - PLATFORM_REVENUE_SHARE) * 100); // e.g. 70

export async function GET() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) return jsonError("Creator not found", 404);

  return jsonSuccess({
    stripeAccountId: creator.stripeAccountId,
    stripeOnboarded: creator.stripeOnboarded,
    creatorSharePercent: CREATOR_SHARE,
    platformSharePercent: Math.round(PLATFORM_REVENUE_SHARE * 100),
  });
}

export async function POST() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) return jsonError("Creator not found", 404);

  const stripe = getStripe();
  if (!stripe) return jsonError("Stripe is not configured — add STRIPE_SECRET_KEY to your environment", 503);

  // Create the Express account if this is the first time
  let stripeAccountId = creator.stripeAccountId;
  if (!stripeAccountId) {
    const account = await stripe.accounts.create({
      type: "express",
      email: creator.email,
      capabilities: {
        transfers: { requested: true },
      },
      metadata: { creatorId: creator.id },
    });
    stripeAccountId = account.id;

    await prisma.creator.update({
      where: { id: creator.id },
      data: { stripeAccountId },
    });
  }

  // Generate a fresh onboarding link (valid for a short window)
  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${APP_URL}/creator/stripe/connect?refresh=true`,
    return_url: `${APP_URL}/api/creator/stripe/return?accountId=${stripeAccountId}`,
    type: "account_onboarding",
  });

  return jsonSuccess({ url: accountLink.url });
}
