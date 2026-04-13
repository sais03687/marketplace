import { NextRequest } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key);
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");

  let event: Stripe.Event;

  try {
    if (!webhookSecret || !sig) {
      // Development fallback: accept unverified events when secret isn't configured
      event = JSON.parse(body) as Stripe.Event;
    } else {
      event = getStripe().webhooks.constructEvent(body, sig, webhookSecret);
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

      if (deploymentId && subscriptionId) {
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: { stripeSubscriptionId: subscriptionId },
        });
      }
      break;
    }

    case "invoice.paid": {
      const subscriptionId = obj.subscription as string | null;
      if (subscriptionId) {
        // Mark subscription as active — deployment continues
        const deployment = await prisma.deployment.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
        });
        if (deployment && deployment.status === "PAUSED") {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { status: "ACTIVE", pausedAt: null },
          });
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      const subscriptionId = obj.subscription as string | null;
      if (subscriptionId) {
        // Pause deployment on payment failure
        const deployment = await prisma.deployment.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
        });
        if (deployment) {
          await prisma.deployment.update({
            where: { id: deployment.id },
            data: { status: "PAUSED", pausedAt: new Date() },
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
      if (deployment) {
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: "FIRED", firedAt: new Date() },
        });
      }
      break;
    }
  }

  return jsonSuccess({ received: true });
}
