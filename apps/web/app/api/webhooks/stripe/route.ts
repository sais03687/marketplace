import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";
import { getProvisioningQueue } from "@/lib/provisioning-queue";


async function enqueueDeprovision(deploymentId: string) {
  try {
    await getProvisioningQueue().add("deprovision", { type: "deprovision", deploymentId });
  } catch (err: any) {
    console.error(`[stripe-webhook] Failed to enqueue deprovision for ${deploymentId}: ${err.message}`);
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  const webhookSecret = getStripeWebhookSecret();

  let event: Stripe.Event;

  try {
    if (!webhookSecret || !sig) {
      // Development fallback: accept unverified events when secret isn't configured
      event = JSON.parse(body) as Stripe.Event;
    } else {
      const stripe = getStripe();
      if (!stripe) {
        return jsonError("Stripe is not configured", 503);
      }
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    }
  } catch (err: any) {
    return jsonError(`Webhook signature verification failed: ${err.message}`, 400);
  }

  const obj = event.data.object as unknown as Record<string, unknown>;

  switch (event.type) {
    case "checkout.session.completed": {
      const metadata = obj.metadata as Record<string, string> | undefined;
      const deploymentId = metadata?.deploymentId ?? null;
      const subscriptionId = obj.subscription as string | null;
      const customerId = obj.customer as string | null;

      if (deploymentId && subscriptionId) {
        // Advance from PENDING_PAYMENT → PROVISIONING and save subscription ID
        const deployment = await prisma.deployment.update({
          where: { id: deploymentId },
          data: { stripeSubscriptionId: subscriptionId, status: "PROVISIONING" },
          include: { company: true },
        });

        // Persist the Stripe customer ID on the company (idempotent)
        if (customerId && deployment.company && !deployment.company.stripeCustomerId) {
          await prisma.company.update({
            where: { id: deployment.company.id },
            data: { stripeCustomerId: customerId },
          });
        }

        // Now enqueue provisioning — payment is confirmed
        await getProvisioningQueue().add("provision", { type: "provision", deploymentId });
      }
      break;
    }

    case "checkout.session.expired": {
      // Buyer abandoned the checkout — delete the PENDING_PAYMENT deployment so it
      // doesn't linger in the dashboard.
      const metadata = obj.metadata as Record<string, string> | undefined;
      const deploymentId = metadata?.deploymentId ?? null;
      if (deploymentId) {
        await prisma.deployment.deleteMany({
          where: { id: deploymentId, status: "PENDING_PAYMENT" },
        });
      }
      break;
    }

    case "invoice.paid": {
      const subscriptionId = obj.subscription as string | null;
      if (subscriptionId) {
        const deployment = await prisma.deployment.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
        });
        if (deployment && deployment.status === "PAUSED") {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { status: "ACTIVE", pausedAt: null, pauseReason: null },
          });
          // Restart the container if it was paused for billing
          try {
            await getProvisioningQueue().add("resume", { type: "resume", deploymentId: deployment.id });
          } catch (err: any) {
            console.error(`[stripe-webhook] Failed to enqueue resume for ${deployment.id}: ${err.message}`);
          }
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      const subscriptionId = obj.subscription as string | null;
      if (subscriptionId) {
        const deployment = await prisma.deployment.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
        });
        if (deployment && deployment.status !== "FIRED") {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: {
              status: "PAUSED",
              pausedAt: new Date(),
              pauseReason: "Payment failed — please update your billing details to resume this agent.",
            },
          });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscriptionId = obj.id as string;
      const deployment = await prisma.deployment.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
      });
      if (deployment && deployment.status !== "FIRED") {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: "FIRED", firedAt: new Date() },
        });
        // Trigger full cleanup: stop gateway, delete inbox, delete service account
        await enqueueDeprovision(deployment.id);
      }
      break;
    }

    // Creator Connect account updated — mark as onboarded when fully verified
    case "account.updated": {
      const account = obj as unknown as { id: string; charges_enabled: boolean; payouts_enabled: boolean };
      if (account.charges_enabled && account.payouts_enabled) {
        await prisma.creator.updateMany({
          where: { stripeAccountId: account.id },
          data: { stripeOnboarded: true },
        });
      }
      break;
    }
  }

  return jsonSuccess({ received: true });
}
