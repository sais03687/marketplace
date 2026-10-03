import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";

export async function GET() {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  if (!company.stripeCustomerId) {
    return jsonSuccess({ subscriptions: [] });
  }

  // Fetch active deployments with subscription IDs
  const deployments = await prisma.deployment.findMany({
    where: {
      companyId: company.id,
      stripeSubscriptionId: { not: null },
      status: { notIn: ["FIRED"] },
    },
    include: { agent: { select: { name: true, slug: true } } },
  });

  if (deployments.length === 0) {
    return jsonSuccess({ subscriptions: [] });
  }

  const stripe = getStripe();
  if (!stripe) {
    // No Stripe configured — return basic info from DB
    const subscriptions = deployments.map((d) => ({
      deploymentId: d.id,
      agentName: d.agentName,
      agentSlug: d.agent.slug,
      pricePerMonth: d.agent ? null : null,
      status: d.status,
      subscriptionId: d.stripeSubscriptionId,
      currentPeriodEnd: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    }));
    return jsonSuccess({ subscriptions });
  }

  // Enrich with live Stripe data
  const subscriptions = await Promise.all(
    deployments.map(async (d) => {
      try {
        const sub = await stripe.subscriptions.retrieve(d.stripeSubscriptionId!, {
          expand: ["items.data.price"],
        });
        const item = sub.items.data[0];
        return {
          deploymentId: d.id,
          agentName: d.agentName,
          agentSlug: d.agent.slug,
          pricePerMonth: item?.price?.unit_amount ?? null,
          status: d.status,
          subscriptionId: d.stripeSubscriptionId,
          // Stripe moved current_period_end onto the subscription *item* in its
          // 2025 API versions. Reading it off the subscription gave undefined on
          // every row, so the dashboard's "Next Billing" column had been a
          // column of em-dashes. The subscription-level field is kept as a
          // fallback for older API versions.
          currentPeriodEnd: (() => {
            const ts =
              (item as any)?.current_period_end ?? (sub as any).current_period_end ?? null;
            return ts ? new Date(ts * 1000).toISOString() : null;
          })(),
          // During the trial this is the date the buyer is first charged, which
          // is the one thing they want from this page after a hire.
          trialEnd: (sub as any).trial_end
            ? new Date((sub as any).trial_end * 1000).toISOString()
            : null,
          cancelAtPeriodEnd: (sub as any).cancel_at_period_end ?? false,
        };
      } catch {
        return {
          deploymentId: d.id,
          agentName: d.agentName,
          agentSlug: d.agent.slug,
          pricePerMonth: null,
          status: d.status,
          subscriptionId: d.stripeSubscriptionId,
          currentPeriodEnd: null,
          trialEnd: null,
          cancelAtPeriodEnd: false,
        };
      }
    }),
  );

  return jsonSuccess({ subscriptions });
}
