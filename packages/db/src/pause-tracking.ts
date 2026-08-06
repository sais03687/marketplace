/**
 * Pause accounting: the record of *when* a deployment was paused.
 *
 * Both the buyer charge and the creator payout used to read `deployment.status`
 * at a single instant and apply that answer to an entire billing month. The
 * buyer's discount was sampled at renewal, the creator's at whenever the payout
 * cron happened to run — two different instants, so the two sides could disagree
 * about the same month in either direction, with the platform absorbing the gap.
 *
 * Every status change therefore has to go through `setDeploymentPaused`. If any
 * caller writes `status: "PAUSED"` directly the interval is never opened, the
 * time is never credited, and nothing surfaces the omission — the same silent
 * shape as the discount that logged "Removed" while removing nothing.
 */

import { prisma } from "./index.js";

/** An interval clamped to a measurement window. Half-open: [start, end). */
export interface Interval {
  start: Date;
  end: Date;
}

/**
 * Move a deployment in or out of PAUSED, keeping the interval log in step.
 *
 * Idempotent in both directions: pausing an already-paused deployment does not
 * open a second overlapping interval, and resuming one that is not paused does
 * not close anything. Callers retry, queues deliver twice, and two overlapping
 * intervals would silently double the credit.
 */
export async function setDeploymentPaused(
  deploymentId: string,
  paused: boolean,
  opts: { reason?: string | null; status?: string; at?: Date } = {},
): Promise<void> {
  const at = opts.at ?? new Date();
  const open = await prisma.pausePeriod.findFirst({
    where: { deploymentId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });

  if (paused) {
    if (!open) {
      await prisma.pausePeriod.create({
        data: { deploymentId, startedAt: at, reason: opts.reason ?? null },
      });
    }
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: (opts.status ?? "PAUSED") as never,
        pausedAt: at,
        ...(opts.reason !== undefined ? { pauseReason: opts.reason } : {}),
      },
    });
    return;
  }

  if (open) {
    // Guard against a clock skew or a replayed job closing an interval before it
    // opened, which would make the duration negative and credit the wrong way.
    await prisma.pausePeriod.update({
      where: { id: open.id },
      data: { endedAt: at > open.startedAt ? at : open.startedAt },
    });
  }
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: (opts.status ?? "ACTIVE") as never,
      pausedAt: null,
      ...(opts.reason !== undefined ? { pauseReason: opts.reason } : {}),
    },
  });
}

/**
 * Total milliseconds a deployment was paused within [from, to).
 *
 * An interval still open (`endedAt: null`) is clamped to `to`, so a pause that
 * is ongoing at renewal is credited up to the renewal and the remainder falls to
 * the next cycle. Overlapping intervals are merged before summing — they should
 * not exist, but double-counting them would inflate a refund, so the arithmetic
 * refuses to depend on the write path being perfect.
 */
export async function pausedMsBetween(
  deploymentId: string,
  from: Date,
  to: Date,
): Promise<number> {
  if (to <= from) return 0;

  const periods = await prisma.pausePeriod.findMany({
    where: {
      deploymentId,
      startedAt: { lt: to },
      OR: [{ endedAt: null }, { endedAt: { gt: from } }],
    },
    orderBy: { startedAt: "asc" },
  });

  const clamped: Interval[] = periods
    .map((p) => ({
      start: p.startedAt < from ? from : p.startedAt,
      end: (p.endedAt ?? to) > to ? to : (p.endedAt ?? to),
    }))
    .filter((i) => i.end > i.start);

  let total = 0;
  let cursor: Interval | null = null;
  for (const i of clamped) {
    if (cursor && i.start <= cursor.end) {
      if (i.end > cursor.end) cursor.end = i.end;
      continue;
    }
    if (cursor) total += cursor.end.getTime() - cursor.start.getTime();
    cursor = { start: i.start, end: i.end };
  }
  if (cursor) total += cursor.end.getTime() - cursor.start.getTime();

  return total;
}
