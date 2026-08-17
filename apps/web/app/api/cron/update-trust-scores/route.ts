import { prisma } from "@/lib/db";
import { autonomyFor } from "@/lib/autonomy";
import { jsonSuccess, jsonError } from "@/lib/api-utils";

/**
 * Cron routes bypass Clerk by design (middleware's isInternalRoute), so the Bearer
 * check below is the only thing standing in front of them. Both of these ran for
 * anyone until 2026-08-04 — an unauthenticated POST from a shell returned 200 —
 * while the third cron route, creator-payouts, had checked all along. That
 * asymmetry is the whole bug: the pattern existed and these two just missed it.
 */
const CRON_SECRET = process.env.CRON_SECRET || "";

function unauthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") || "";
  return !!CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`;
}

export async function POST(request: Request) {
  if (unauthorized(request)) return jsonError("Unauthorized", 401);
  const scores = await prisma.trustScore.findMany({
    include: { deployment: { select: { id: true } } },
  });

  let updated = 0;
  for (const score of scores) {
    // Recency-weighted calculation
    // Last 30 days get 2x weight
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const recentApprovals = await prisma.approval.findMany({
      where: {
        deploymentId: score.deploymentId,
        taskType: score.taskType,
        status: { in: ["APPROVED", "EDITED", "REJECTED"] },
        resolvedAt: { gte: thirtyDaysAgo },
      },
    });

    const olderApprovals = await prisma.approval.findMany({
      where: {
        deploymentId: score.deploymentId,
        taskType: score.taskType,
        status: { in: ["APPROVED", "EDITED", "REJECTED"] },
        resolvedAt: { lt: thirtyDaysAgo },
      },
    });

    // Weight: recent = 2x, older = 1x
    let weightedApproved = 0;
    let weightedTotal = 0;

    for (const a of recentApprovals) {
      weightedTotal += 2;
      if (a.status === "APPROVED") weightedApproved += 2;
    }
    for (const a of olderApprovals) {
      weightedTotal += 1;
      if (a.status === "APPROVED") weightedApproved += 1;
    }

    const weightedScore =
      weightedTotal > 0 ? weightedApproved / weightedTotal : 0;

    const total = recentApprovals.length + olderApprovals.length;

    // Thresholds and the question floor both live in lib/autonomy.
    const autonomyLevel = autonomyFor(score.taskType, weightedScore, total);

    await prisma.trustScore.update({
      where: { id: score.id },
      data: {
        weightedScore,
        autonomyLevel,
        approvedNoEdit: recentApprovals.filter((a) => a.status === "APPROVED")
          .length + olderApprovals.filter((a) => a.status === "APPROVED").length,
        edited: recentApprovals.filter((a) => a.status === "EDITED").length +
          olderApprovals.filter((a) => a.status === "EDITED").length,
        rejected: recentApprovals.filter((a) => a.status === "REJECTED").length +
          olderApprovals.filter((a) => a.status === "REJECTED").length,
        lastUpdated: new Date(),
      },
    });

    updated++;
  }

  return jsonSuccess({ updated });
}
