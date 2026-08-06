import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { setDeploymentPaused } from "@marketplace/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";
import { settlePauseCredit } from "@/lib/pause-credit";
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
    if (webhookSecret) {
      // A configured secret means verification is mandatory. The condition here
      // used to be `!webhookSecret || !sig`, so an unsigned request took the
      // development fallback and was accepted unverified *even in production with
      // the secret set* — the bypass was chosen by the caller simply by omitting
      // the stripe-signature header. Confirmed against production on 2026-08-04:
      // an unsigned forged event returned 200, the same event with a junk
      // signature returned 400.
      //
      // These handlers are not read-only. A forged customer.subscription.deleted
      // enqueues a deprovision, which deletes the agent's Microsoft identity,
      // mailbox, container and data volume; a forged checkout.session.completed
      // provisions an agent that nobody paid for.
      //
      // Nothing legitimate is lost: Stripe always sends the header, so this only
      // rejects callers that are not Stripe.
      if (!sig) {
        console.error("[stripe-webhook] Rejected an unsigned request — stripe-signature header is missing");
        return jsonError("Missing stripe-signature header", 400);
      }
      const stripe = getStripe();
      if (!stripe) {
        return jsonError("Stripe is not configured", 503);
      }
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } else if (process.env.NODE_ENV === "production") {
      // Fail closed. Unverified events are a local convenience, never a
      // production posture, and silently accepting them is how this got missed.
      console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing to process unverified events");
      return jsonError("Webhook verification is not configured", 503);
    } else {
      event = JSON.parse(body) as Stripe.Event;
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
        // Advance from PENDING_PAYMENT → PROVISIONING and save subscription ID.
        //
        // Conditional on still being PENDING_PAYMENT, because Stripe delivers at
        // least once and retries on any non-2xx — four retries of this very event
        // were queued on 2026-08-06 while the signing secret was wrong. Without
        // the condition, a duplicate delivery would drag an ACTIVE deployment
        // back to PROVISIONING and enqueue a second provision job for an agent
        // that already has a mailbox and a container. Provisioning twice is not
        // a no-op: it is the path that once deleted a live agent's M365 identity
        // through the 409 container-name rollback.
        const { count } = await prisma.deployment.updateMany({
          where: { id: deploymentId, status: "PENDING_PAYMENT" },
          data: { stripeSubscriptionId: subscriptionId, status: "PROVISIONING" },
        });

        if (count === 0) {
          // Already handled. Record the subscription id if it is somehow missing,
          // but do not touch status and do not enqueue.
          await prisma.deployment.updateMany({
            where: { id: deploymentId, stripeSubscriptionId: null },
            data: { stripeSubscriptionId: subscriptionId },
          });
          console.log(
            `[stripe-webhook] checkout.session.completed for ${deploymentId} ignored — ` +
              `already past PENDING_PAYMENT (duplicate delivery)`,
          );
          break;
        }

        const deployment = await prisma.deployment.findUniqueOrThrow({
          where: { id: deploymentId },
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

    case "invoice.created": {
      // Settle paused time for the cycle that just ended, onto this draft.
      //
      // This is the only place the buyer is credited for a pause. Stripe creates
      // the draft roughly an hour before finalising it, and pending invoice items
      // attach to a draft but not to a finalised invoice, so the work has to
      // happen here rather than on invoice.paid.
      //
      // If this handler is missed or fails, the watermark does not advance and
      // the uncredited time rolls into the next renewal. Late is recoverable;
      // lost is not.
      const subscriptionId = obj.subscription as string | null;
      const invoiceId = obj.id as string | undefined;
      if (subscriptionId) {
        const deployment = await prisma.deployment.findFirst({
          where: { stripeSubscriptionId: subscriptionId },
          select: { id: true },
        });
        if (deployment) {
          const periodStart = (obj.period_start as number | undefined) ?? null;
          const periodEnd = (obj.period_end as number | undefined) ?? null;
          const cycleMs =
            periodStart && periodEnd && periodEnd > periodStart
              ? (periodEnd - periodStart) * 1000
              : undefined;
          try {
            await settlePauseCredit(deployment.id, { cycleMs, invoiceId });
          } catch (err: any) {
            console.error(
              `[stripe-webhook] Failed to settle pause credit for ${deployment.id} on ` +
                `invoice ${invoiceId}: ${err.message}. The buyer is owed this credit; ` +
                `it will roll into the next renewal because the watermark did not advance.`,
            );
          }
        }
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
          await setDeploymentPaused(deployment.id, false, { reason: null });
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
          await setDeploymentPaused(deployment.id, true, {
            reason: "Payment failed — please update your billing details to resume this agent.",
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
