/**
 * Credit a buyer for time their agent actually spent paused.
 *
 * Replaces a 50%-off coupon that was attached on pause and removed on resume.
 * A coupon is evaluated once, when the invoice generates, so it answered the
 * wrong question: it asked "is this agent paused right now?" instead of "how
 * much of the month was it paused?". A three-week pause ending before renewal
 * earned the buyer nothing, while pausing across the renewal date bought a full
 * month at half price for an agent that ran all but two days of it.
 *
 * Settlement runs in arrears: at each renewal we look back over the cycle that
 * just ended, total the paused time, and put a credit line on the invoice. The
 * buyer pays the month ahead in full, minus what they overpaid last month.
 */

import { prisma } from "@/lib/db";
import { pausedMsBetween } from "@marketplace/db";
import { getStripe } from "@/lib/stripe";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOMINAL_CYCLE_MS = 30 * DAY_MS;

/** Fraction of the monthly price still charged while an agent is paused. */
export const PAUSED_RATE = 0.5;

export interface SettleResult {
  creditedCents: number;
  pausedDays: number;
  reason?: string;
}

/**
 * Settle everything not yet credited up to `until`.
 *
 * `cycleMs` is the length of the billing period the credit lands against; the
 * credit is a fraction of one month's price, so the denominator has to be the
 * cycle the price buys, not the window we happen to be measuring.
 *
 * The watermark advances only on success. A failed or missed settlement leaves
 * it where it was, so the next renewal picks up the uncredited time instead of
 * losing it — this path silently owing a buyer money is the failure mode worth
 * engineering against.
 */
export async function settlePauseCredit(
  deploymentId: string,
  opts: { until?: Date; cycleMs?: number; invoiceId?: string; toCustomerBalance?: boolean } = {},
): Promise<SettleResult> {
  const until = opts.until ?? new Date();

  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: {
      agent: { select: { pricePerMonth: true } },
      company: { select: { stripeCustomerId: true } },
    },
  });

  if (!deployment) return { creditedCents: 0, pausedDays: 0, reason: "no such deployment" };

  const price = deployment.agent?.pricePerMonth ?? 0;
  if (price <= 0) return { creditedCents: 0, pausedDays: 0, reason: "free agent" };

  const customerId = deployment.company?.stripeCustomerId;
  if (!customerId) return { creditedCents: 0, pausedDays: 0, reason: "no stripe customer" };

  const stripe = getStripe();
  if (!stripe) return { creditedCents: 0, pausedDays: 0, reason: "stripe not configured" };

  // Never credit time from before the buyer started paying.
  const from = deployment.pauseCreditedThrough ?? deployment.createdAt;
  if (until <= from) return { creditedCents: 0, pausedDays: 0, reason: "nothing new to settle" };

  const pausedMs = await pausedMsBetween(deploymentId, from, until);
  const cycleMs = opts.cycleMs && opts.cycleMs > 0 ? opts.cycleMs : NOMINAL_CYCLE_MS;
  const pausedDays = pausedMs / DAY_MS;

  // Round toward the buyer. Fractions of a cent that vanish should vanish in
  // their favour, not ours.
  const creditCents = Math.ceil((price * PAUSED_RATE * pausedMs) / cycleMs);

  if (creditCents <= 0) {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { pauseCreditedThrough: until },
    });
    return { creditedCents: 0, pausedDays, reason: "no paused time in window" };
  }

  const description =
    `Paused ${pausedDays.toFixed(1)} day${pausedDays.toFixed(1) === "1.0" ? "" : "s"} ` +
    `— ${Math.round((1 - PAUSED_RATE) * 100)}% credit`;

  if (opts.toCustomerBalance) {
    // Firing cancels the subscription, so there is no future invoice for a
    // pending invoice item to attach to and the credit would simply evaporate.
    // Customer balance survives the subscription and is drawn down by any later
    // invoice on the same company, which is the closest thing to "we still owe
    // you this" that Stripe models directly.
    await stripe.customers.createBalanceTransaction(customerId, {
      amount: -creditCents,
      currency: "usd",
      description,
    });
  } else {
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: -creditCents,
      currency: "usd",
      description,
      ...(opts.invoiceId ? { invoice: opts.invoiceId } : {}),
      ...(deployment.stripeSubscriptionId ? { subscription: deployment.stripeSubscriptionId } : {}),
    });
  }

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { pauseCreditedThrough: until },
  });

  console.log(
    `[pause-credit] Credited ${(creditCents / 100).toFixed(2)} to ${customerId} for ` +
      `${pausedDays.toFixed(2)} paused days on ${deploymentId}` +
      // Say where it actually went. This read "(next invoice)" for the fire path,
      // which settles to customer balance — the same describing-intent-not-outcome
      // habit that hid the half-rate coupon never being removed.
      (opts.toCustomerBalance
        ? " (customer balance)"
        : opts.invoiceId
          ? ` (invoice ${opts.invoiceId})`
          : " (next invoice)"),
  );

  return { creditedCents: creditCents, pausedDays };
}
