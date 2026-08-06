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
  const company = await prisma.company.create({
    data: { name: "pause-credit-check", domain: `pcc-${Date.now()}.invalid` },
  });
  const creator = await prisma.creator.create({
    data: { name: "pcc", email: `pcc-${Date.now()}@invalid` },
  });
  const agent = await prisma.agent.create({
    data: {
      creatorId: creator.id,
      name: "pcc-agent",
      slug: `pcc-agent-${Date.now()}`,
      description: "scratch",
      category: "OTHER",
      pricePerMonth: 5900,
      modelTier: "SONNET",
    },
  });
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

  const days = async (from: Date, to: Date) => (await pausedMsBetween(dep.id, from, to)) / DAY;

  try {
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
    await prisma.pausePeriod.deleteMany({ where: { deploymentId: dep.id } });
    await prisma.deployment.delete({ where: { id: dep.id } });
    await prisma.agent.delete({ where: { id: agent.id } });
    await prisma.creator.delete({ where: { id: creator.id } });
    await prisma.company.delete({ where: { id: company.id } });
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
