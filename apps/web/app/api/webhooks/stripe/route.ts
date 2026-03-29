import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";

// In production, verify Stripe webhook signature with stripe.webhooks.constructEvent
export async function POST(request: NextRequest) {
  const body = await request.text();
  let event: { type: string; data: { object: Record<string, unknown> } };

  try {
    event = JSON.parse(body);
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const deploymentId = obj.metadata
        ? (obj.metadata as Record<string, string>).deploymentId
        : null;
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
