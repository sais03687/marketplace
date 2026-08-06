import Stripe from "stripe";

/**
 * Returns a configured Stripe client, or null if the secret key is missing
 * or is still the placeholder value from .env.example.
 *
 * Placeholder detection: real Stripe keys start with "sk_test_" or "sk_live_"
 * followed by at least 20 real characters (no "..." or "xxx").
 */
export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // Reject placeholder values like "sk_test_..." or "sk_test_xxx"
  if (key.includes("...") || key.endsWith("xxx") || key.length < 30) return null;
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) return null;
  return new Stripe(key);
}

export function getStripeWebhookSecret(): string | null {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;
  if (secret.includes("...") || secret.length < 20) return null;
  return secret;
}

export function isStripeConfigured(): boolean {
  return getStripe() !== null;
}

/**
 * The 50%-off coupon applied while an agent is paused.
 *
 * A paused agent still costs the platform: its Microsoft 365 licence seat stays
 * consumed so the mailbox and address survive, its data volume is kept intact so
 * resuming restores the agent rather than rebuilding it, and its identity is held
 * so it comes back as the same colleague rather than a new one. Half rate is the
 * price of holding all that without the agent doing any work.
 *
 * Created on first use rather than assumed to exist, because coupons are
 * mode-specific like every other Stripe object — one made with a live key is
 * invisible to a test key, which is exactly the trap that cost an afternoon on
 * 2026-08-06 with a customer id.
 */
export const PAUSE_COUPON_ID = "agent-paused-half-rate";

export async function getOrCreatePauseCoupon(
  stripe: import("stripe").default,
): Promise<string> {
  try {
    const existing = await stripe.coupons.retrieve(PAUSE_COUPON_ID);
    if (!existing.deleted) return existing.id;
  } catch {
    // Not found in this mode — fall through and create it.
  }
  const created = await stripe.coupons.create({
    id: PAUSE_COUPON_ID,
    percent_off: 50,
    duration: "forever",
    name: "Agent paused — half rate",
  });
  return created.id;
}
