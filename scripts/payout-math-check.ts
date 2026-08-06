/**
 * Checks that creator payouts actually bill paused days at half rate.
 *
 * Run on the VPS, where DATABASE_URL and CRON_SECRET are both present:
 *   cd /opt/marketplace && set -a && . ./.env.prod && set +a && npx tsx scripts/payout-math-check.ts
 *
 * Builds a scratch creator whose single deployment spans the whole of the prior
 * calendar month, calls the real cron in dryRun mode (which records nothing and
 * transfers nothing), and reads back what it was going to pay.
 *
 * The assertion is deliberately not a re-derivation of the formula — copying the
 * arithmetic into the test would pass just as happily if the cron ignored pauses
 * altogether. Instead it runs the same month twice, once with a pause and once
 * without, and checks the *difference*: paused days must cost the creator
 * exactly half the daily rate, no more and no less.
 */

import { prisma } from "@marketplace/db";

const DAY = 24 * 60 * 60 * 1000;
const PRICE = 5900;
const PAUSED_DAYS = 10;

const now = new Date();
const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const daysInMonth = (periodEnd.getTime() - periodStart.getTime()) / DAY;

const CRON_SECRET = process.env.CRON_SECRET || "";
const BASE = process.env.NEXT_PUBLIC_APP_URL || "https://www.agentstore.it.com";

async function runCron(): Promise<any[]> {
  const res = await fetch(`${BASE}/api/cron/creator-payouts?dryRun=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`cron returned ${res.status}: ${JSON.stringify(body)}`);
  return body.results ?? [];
}

function shareFor(results: any[], creatorId: string): number {
  const row = results.find((r) => r.creatorId === creatorId);
  if (!row) throw new Error(`creator ${creatorId} missing from cron results`);
  return row.amountCents ?? 0;
}

async function main() {
  const stamp = Date.now();
  let companyId: string | null = null;
  let creatorId: string | null = null;
  let agentId: string | null = null;
  let depId: string | null = null;
  let failures = 0;

  try {
    const company = await prisma.company.create({
      data: {
        clerkOrgId: `pmc-org-${stamp}`,
        name: "payout-math-check",
        domain: `pmc-${stamp}.invalid`,
      },
    });
    companyId = company.id;

    const creator = await prisma.creator.create({
      data: { clerkUserId: `pmc-user-${stamp}`, displayName: "pmc", email: `pmc-${stamp}@invalid` },
    });
    creatorId = creator.id;

    const agent = await prisma.agent.create({
      data: {
        creatorId: creator.id,
        name: "pmc-agent",
        slug: `pmc-agent-${stamp}`,
        tagline: "scratch",
        description: "scratch",
        category: "GENERAL",
        pricePerMonth: PRICE,
        modelTier: "SONNET",
      },
    });
    agentId = agent.id;

    // Active for the entire prior month, so activeDays is the whole period and
    // the only thing that can move the number is the pause.
    const dep = await prisma.deployment.create({
      data: {
        companyId: company.id,
        agentId: agent.id,
        agentVersion: "1.0.0",
        agentName: "pmc",
        status: "ACTIVE",
        autonomyConfig: {},
        createdAt: periodStart,
      },
    });
    depId = dep.id;

    console.log(
      `period ${periodStart.toISOString().slice(0, 10)} → ${periodEnd.toISOString().slice(0, 10)} ` +
        `(${daysInMonth} days), agent at $${(PRICE / 100).toFixed(2)}/mo\n`,
    );

    const noPause = shareFor(await runCron(), creator.id);
    console.log(`never paused:        creator share $${(noPause / 100).toFixed(2)}`);

    // Ten days paused, wholly inside the period.
    await prisma.pausePeriod.create({
      data: {
        deploymentId: dep.id,
        startedAt: new Date(periodStart.getTime() + 5 * DAY),
        endedAt: new Date(periodStart.getTime() + (5 + PAUSED_DAYS) * DAY),
      },
    });

    const withPause = shareFor(await runCron(), creator.id);
    console.log(`${PAUSED_DAYS} days paused:      creator share $${(withPause / 100).toFixed(2)}`);

    // What the pause should have cost: half the daily rate for each paused day,
    // less the platform's cut of that reduction.
    const platformShare = parseFloat(process.env.PLATFORM_REVENUE_SHARE || "0.30");
    const dailyRate = PRICE / daysInMonth;
    const expectedGrossDrop = dailyRate * PAUSED_DAYS * 0.5;
    const expectedShareDrop = expectedGrossDrop * (1 - platformShare);
    const actualShareDrop = noPause - withPause;

    console.log(
      `\nreduction:           $${(actualShareDrop / 100).toFixed(2)} ` +
        `(expected ~$${(expectedShareDrop / 100).toFixed(2)})`,
    );

    // Two cents of slack for the rounding that happens per-deployment and again
    // on the platform fee.
    const ok = Math.abs(actualShareDrop - expectedShareDrop) <= 2;
    console.log(`${ok ? "PASS" : "FAIL"}  paused days cost half rate`);
    if (!ok) failures++;

    const moved = actualShareDrop > 0;
    console.log(`${moved ? "PASS" : "FAIL"}  pause actually changed the payout`);
    if (!moved) failures++;
  } finally {
    if (depId) await prisma.pausePeriod.deleteMany({ where: { deploymentId: depId } });
    if (depId) await prisma.deployment.delete({ where: { id: depId } });
    if (agentId) await prisma.agent.delete({ where: { id: agentId } });
    if (creatorId) await prisma.creator.delete({ where: { id: creatorId } });
    if (companyId) await prisma.company.delete({ where: { id: companyId } });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
