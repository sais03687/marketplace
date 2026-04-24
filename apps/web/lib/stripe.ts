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
