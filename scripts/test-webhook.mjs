/**
 * Sends a signed test webhook to your production endpoint.
 * Usage:
 *   node scripts/test-webhook.mjs <event-type>
 * Example:
 *   node scripts/test-webhook.mjs account.updated
 *   node scripts/test-webhook.mjs invoice.payment_failed
 *   node scripts/test-webhook.mjs invoice.paid
 *   node scripts/test-webhook.mjs customer.subscription.deleted
 */

import crypto from "node:crypto";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ENDPOINT_URL =
  process.env.WEBHOOK_URL ||
  "https://marketplace-web-gamma-two.vercel.app/api/webhooks/stripe";

if (!WEBHOOK_SECRET) {
  console.error("Error: STRIPE_WEBHOOK_SECRET env var is required");
  console.error("Run: STRIPE_WEBHOOK_SECRET=whsec_... node scripts/test-webhook.mjs <event-type>");
  process.exit(1);
}

const eventType = process.argv[2] || "account.updated";

// Minimal test payloads for each event type
const PAYLOADS = {
  "account.updated": {
    id: "evt_test_account_updated",
    object: "event",
    type: "account.updated",
    livemode: false,
    data: {
      object: {
        id: "acct_test123",
        object: "account",
        charges_enabled: true,
        payouts_enabled: true,
      },
    },
  },
  "invoice.payment_failed": {
    id: "evt_test_payment_failed",
    object: "event",
    type: "invoice.payment_failed",
    livemode: false,
    data: {
      object: {
        id: "in_test123",
        object: "invoice",
        subscription: "sub_test_does_not_exist",
      },
    },
  },
  "invoice.paid": {
    id: "evt_test_invoice_paid",
    object: "event",
    type: "invoice.paid",
    livemode: false,
    data: {
      object: {
        id: "in_test456",
        object: "invoice",
        subscription: "sub_test_does_not_exist",
      },
    },
  },
  "customer.subscription.deleted": {
    id: "evt_test_sub_deleted",
    object: "event",
    type: "customer.subscription.deleted",
    livemode: false,
    data: {
      object: {
        id: "sub_test_does_not_exist",
        object: "subscription",
      },
    },
  },
  "checkout.session.completed": {
    id: "evt_test_checkout_completed",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test123",
        object: "checkout.session",
        metadata: { deploymentId: "test_deployment_id" },
        subscription: "sub_test123",
        customer: "cus_test123",
      },
    },
  },
};

const payload = PAYLOADS[eventType];
if (!payload) {
  console.error(`Unknown event type: ${eventType}`);
  console.error(`Valid types: ${Object.keys(PAYLOADS).join(", ")}`);
  process.exit(1);
}

const body = JSON.stringify(payload);
const timestamp = Math.floor(Date.now() / 1000);
const signedPayload = `${timestamp}.${body}`;
const signature = crypto
  .createHmac("sha256", WEBHOOK_SECRET)
  .update(signedPayload)
  .digest("hex");

const stripeSignature = `t=${timestamp},v1=${signature}`;

console.log(`Sending test event: ${eventType}`);
console.log(`Endpoint: ${ENDPOINT_URL}`);
console.log("");

const res = await fetch(ENDPOINT_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "stripe-signature": stripeSignature,
  },
  body,
});

const text = await res.text();
console.log(`Status: ${res.status}`);
console.log(`Response: ${text}`);

if (res.status === 200) {
  console.log("\n✓ Webhook accepted successfully");
} else {
  console.log("\n✗ Webhook rejected");
}
