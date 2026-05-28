/**
 * Stripe Connect return URL — called after a creator completes onboarding.
 * Verifies the account is actually onboarded (charges_enabled), marks the
 * creator as onboarded in the DB, then redirects to the creator dashboard.
 */
import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002";

export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get("accountId");

  if (!accountId) {
    return NextResponse.redirect(`${APP_URL}/creator?stripe=error`);
  }

  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.redirect(`${APP_URL}/creator?stripe=error`);
  }

  try {
    const account = await stripe.accounts.retrieve(accountId);

    const onboarded = account.charges_enabled && account.payouts_enabled;

    if (onboarded) {
      await prisma.creator.updateMany({
        where: { stripeAccountId: accountId },
        data: { stripeOnboarded: true },
      });
    }

    const status = onboarded ? "success" : "incomplete";
    return NextResponse.redirect(`${APP_URL}/creator?stripe=${status}`);
  } catch {
    return NextResponse.redirect(`${APP_URL}/creator?stripe=error`);
  }
}
