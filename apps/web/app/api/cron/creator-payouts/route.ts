/**
 * Monthly creator payout cron — runs on the 1st of each month.
 * Wire this to your cron scheduler (Vercel Cron, GitHub Actions, etc.):
 *   Schedule: 0 6 1 * *  (6 AM UTC on the 1st)
 *   URL: POST /api/cron/creator-payouts
 *   Header: Authorization: Bearer {CRON_SECRET}
 *
 * For each creator with a verified Stripe Connect account:
 *   1. Find all their active deployments over the prior calendar month
 *   2. Sum subscription revenue (pricePerMonth × active days / days-in-month)
 *   3. Deduct platform share (PLATFORM_REVENUE_SHARE, default 30%)
 *   4. Transfer the creator share to their Stripe Connect account
 *   5. Record a Payout row in the DB
 *
 * Idempotent: if a payout already exists for the period, skip.
 */
import { prisma } from "@/lib/db";
import { pausedMsBetween } from "@marketplace/db";
import { PAUSED_RATE } from "@/lib/pause-credit";
import { jsonSuccess, jsonError } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";

const PLATFORM_REVENUE_SHARE = parseFloat(process.env.PLATFORM_REVENUE_SHARE || "0.30");
const CRON_SECRET = process.env.CRON_SECRET || "";

export async function POST(request: Request) {
  try {
  // Authenticate the cron caller
  const auth = request.headers.get("authorization") || "";
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return jsonError("Unauthorized", 401);
  }

  const stripe = getStripe();
  const forceDryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const dryRun = stripe === null || forceDryRun; // No Stripe configured or ?dryRun=true — calculate amounts but skip transfers

  // Calculate the prior calendar month
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  // All creators with a verified Stripe Connect account (or all in dry-run mode)
  const creators = await prisma.creator.findMany({
    where: dryRun ? {} : { stripeOnboarded: true, stripeAccountId: { not: null } },
    include: {
      agents: {
        select: {
          pricePerMonth: true,
          deployments: {
            where: {
              // Active during any part of the period
              status: { in: ["ACTIVE", "ONBOARDING", "PAUSED"] },
              createdAt: { lt: periodEnd },
              OR: [
                { firedAt: null },
                { firedAt: { gte: periodStart } },
              ],
            },
            select: {
              id: true,
              status: true,
              createdAt: true,
              pausedAt: true,
              firedAt: true,
            },
          },
        },
      },
    },
  });

  const results: Array<{ creatorId: string; status: string; amountCents?: number; error?: string }> = [];
  const daysInMonth = (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24);

  if (dryRun) {
    console.log("[creator-payouts] STRIPE_SECRET_KEY not set — running in dry-run mode (no transfers)");
  }

  for (const creator of creators) {
    try {
      // Idempotency: skip if payout already exists for this period
      const existing = await prisma.payout.findFirst({
        where: {
          creatorId: creator.id,
          periodStart,
          status: { in: ["PENDING", "PAID"] },
        },
      });
      if (existing) {
        results.push({ creatorId: creator.id, status: "skipped (already processed)" });
        continue;
      }

      // Calculate gross revenue: pricePerMonth × active fraction of the period
      let grossCents = 0;
      for (const agent of creator.agents) {
        for (const dep of agent.deployments) {
          // Clamp deployment lifetime to the billing period
          const start = Math.max(dep.createdAt.getTime(), periodStart.getTime());
          const end = Math.min(
            dep.firedAt?.getTime() ?? periodEnd.getTime(),
            periodEnd.getTime(),
          );
          const activeDays = Math.max(0, (end - start) / (1000 * 60 * 60 * 24));

          // Paused days earn the creator half rate; running days earn full.
          //
          // This used to be `dep.status === "PAUSED" ? 0.5 : 1.0` — the status at
          // the instant the cron happened to run, applied to the entire month. A
          // one-day pause halved a creator's month, and a 25-day pause paid them
          // in full if the agent happened to be running when this fired. It was
          // also a *different* instant from the one the buyer's charge was
          // sampled at, so the two sides could disagree about the same month in
          // either direction, with the platform absorbing the difference.
          const pausedDays =
            activeDays > 0
              ? Math.min(
                  activeDays,
                  (await pausedMsBetween(dep.id, new Date(start), new Date(end))) /
                    (1000 * 60 * 60 * 24),
                )
              : 0;
          const runningDays = Math.max(0, activeDays - pausedDays);
          const dailyRateCents = agent.pricePerMonth / daysInMonth;
          grossCents += Math.round(dailyRateCents * (runningDays + pausedDays * PAUSED_RATE));
        }
      }

      if (grossCents <= 0) {
        results.push({ creatorId: creator.id, status: "skipped (no revenue)" });
        continue;
      }

      const platformFeeCents = Math.round(grossCents * PLATFORM_REVENUE_SHARE);
      const creatorShareCents = grossCents - platformFeeCents;

      if (dryRun) {
        // Dry-run: show calculated amounts without recording or transferring
        results.push({
          creatorId: creator.id,
          status: `dry-run (gross=$${(grossCents/100).toFixed(2)}, fee=$${(platformFeeCents/100).toFixed(2)}, share=$${(creatorShareCents/100).toFixed(2)})`,
          amountCents: creatorShareCents,
        });
        continue;
      }

      // Create a pending payout record first (for audit trail even if transfer fails)
      const payout = await prisma.payout.create({
        data: {
          creatorId: creator.id,
          periodStart,
          periodEnd,
          grossRevenueCents: grossCents,
          platformFeeCents,
          creatorShareCents,
          status: "PENDING",
        },
      });

      // Transfer to creator's Stripe Connect account
      const transfer = await stripe!.transfers.create({
        amount: creatorShareCents,
        currency: "usd",
        destination: creator.stripeAccountId!,
        description: `Marketplace payout ${periodStart.toISOString().slice(0, 7)}`,
        metadata: {
          payoutId: payout.id,
          creatorId: creator.id,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
      });

      await prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: "PAID",
          stripeTransferId: transfer.id,
          paidAt: new Date(),
        },
      });

      results.push({ creatorId: creator.id, status: "paid", amountCents: creatorShareCents });
    } catch (err: any) {
      // Record failure so we can retry or manually resolve
      await prisma.payout.create({
        data: {
          creatorId: creator.id,
          periodStart,
          periodEnd,
          grossRevenueCents: 0,
          platformFeeCents: 0,
          creatorShareCents: 0,
          status: "FAILED",
          failureReason: err.message,
        },
      }).catch(() => {}); // best-effort

      results.push({ creatorId: creator.id, status: "failed", error: err.message });
    }
  }

  return jsonSuccess({
    period: `${periodStart.toISOString().slice(0, 7)}`,
    dryRun,
    processed: results.length,
    totalPaidCents: results.reduce((s, r) => s + (r.amountCents ?? 0), 0),
    skipped: results.filter((r) => r.status.startsWith("skipped")).length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
  } catch (err: any) {
    console.error("[creator-payouts] Unhandled error:", err?.stack ?? err);
    return jsonError(`Internal error: ${err.message} | stack: ${err?.stack?.split("\n")[1]?.trim() ?? "?"}`, 500);
  }
}
