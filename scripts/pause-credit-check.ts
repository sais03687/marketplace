/**
 * Checks the pause-credit arithmetic against a scratch deployment.
 *
 * Run on the VPS, where DATABASE_URL points at the real database:
 *   cd /opt/marketplace && set -a && . ./.env.prod && set +a && npx tsx scripts/pause-credit-check.ts
 *
 * Creates a throwaway company/agent/deployment, writes PausePeriod rows directly,
 * asserts what `pausedMsBetween` reports, and deletes everything at the end. It
 * never touches Stripe — the money call is a thin wrapper over this arithmetic,
 * and it is the arithmetic that decides what a buyer is owed.
 */

import { prisma, pausedMsBetween, setDeploymentPaused } from "@marketplace/db";

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-09-01T00:00:00Z");
const at = (days: number) => new Date(t0.getTime() + days * DAY);

let failures = 0;
function check(name: string, actual: number, expected: number, tolerance = 0.001) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${actual.toFixed(4)}d, want ${expected.toFixed(4)}d`);
}

async function main() {
  const stamp = Date.now();

  // Declared out here and cleaned up in the finally below, because creating the
  // fixtures inside the old try/finally boundary meant a failure partway through
  // construction — an enum that turned out not to exist, a required column I had
  // missed — stranded a company and a creator in the production database. Two
  // such rows were found by the payout cron later the same day.
  let companyId: string | null = null;
  let creatorId: string | null = null;
  let agentId: string | null = null;
  let depId: string | null = null;

  try {
  const company = await prisma.company.create({
    data: {
      clerkOrgId: `pcc-org-${stamp}`,
      name: "pause-credit-check",
      domain: `pcc-${stamp}.invalid`,
    },
  });
  companyId = company.id;
  const creator = await prisma.creator.create({
    data: {
      clerkUserId: `pcc-user-${stamp}`,
      displayName: "pcc",
      email: `pcc-${stamp}@invalid`,
    },
  });
  creatorId = creator.id;
  const agent = await prisma.agent.create({
    data: {
      creatorId: creator.id,
      name: "pcc-agent",
      slug: `pcc-agent-${stamp}`,
      tagline: "scratch",
      description: "scratch",
      category: "GENERAL",
      pricePerMonth: 5900,
      modelTier: "SONNET",
    },
  });
  agentId = agent.id;
  const dep = await prisma.deployment.create({
    data: {
      companyId: company.id,
      agentId: agent.id,
      agentVersion: "1.0.0",
      agentName: "pcc",
      status: "ACTIVE",
      autonomyConfig: {},
      createdAt: t0,
    },
  });

  depId = dep.id;

  const days = async (from: Date, to: Date) => (await pausedMsBetween(dep.id, from, to)) / DAY;

    // A closed interval fully inside the window.
    await prisma.pausePeriod.create({
      data: { deploymentId: dep.id, startedAt: at(2), endedAt: at(5) },
    });
    check("closed interval inside window", await days(t0, at(30)), 3);

    // Clamped at both ends: only the overlap counts.
    check("window clipping the interval", await days(at(3), at(4)), 1);
    check("window entirely before", await days(t0, at(1)), 0);
    check("window entirely after", await days(at(6), at(30)), 0);

    // Overlapping intervals must merge, not double-count. These should never be
    // written, but a replayed job that did would otherwise inflate a refund.
    await prisma.pausePeriod.create({
      data: { deploymentId: dep.id, startedAt: at(4), endedAt: at(7) },
    });
    check("overlapping intervals merge", await days(t0, at(30)), 5);

    // An open interval is clamped to the end of the measured window, so a pause
    // still running at renewal is credited up to renewal and no further.
    await prisma.pausePeriod.create({
      data: { deploymentId: dep.id, startedAt: at(10), endedAt: null },
    });
    check("open interval clamps to window end", await days(t0, at(12)), 7);
    check("open interval over a longer window", await days(t0, at(20)), 15);

    // Backwards window is not an error, it is nothing.
    check("inverted window", await days(at(20), at(10)), 0);

    // The helper itself: pausing twice must not open a second interval.
    await prisma.pausePeriod.deleteMany({ where: { deploymentId: dep.id } });
    await setDeploymentPaused(dep.id, true, { at: at(1) });
    await setDeploymentPaused(dep.id, true, { at: at(2) });
    const open = await prisma.pausePeriod.count({
      where: { deploymentId: dep.id, endedAt: null },
    });
    console.log(`${open === 1 ? "PASS" : "FAIL"}  double pause opens one interval: ${open}`);
    if (open !== 1) failures++;

    await setDeploymentPaused(dep.id, false, { at: at(4) });
    await setDeploymentPaused(dep.id, false, { at: at(6) });
    check("double resume closes once", await days(t0, at(30)), 3);

    // What the buyer is actually owed for that, at $59/mo over a 30-day cycle.
    const owed = Math.ceil((5900 * 0.5 * 3 * DAY) / (30 * DAY));
    console.log(`\n$59/mo, 3 paused days in a 30-day cycle -> credit $${(owed / 100).toFixed(2)}`);
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
