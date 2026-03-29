import { prisma } from "@/lib/db";
import { jsonSuccess } from "@/lib/api-utils";

export async function POST() {
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

    // Determine autonomy level from thresholds
    let autonomyLevel = "always_queue";
    if (weightedScore >= 0.95 && total >= 20) {
      autonomyLevel = "auto_execute";
    } else if (weightedScore >= 0.8) {
      autonomyLevel = "queue_if_stakes_gt_7";
    } else if (weightedScore >= 0.6) {
      autonomyLevel = "queue_if_stakes_gt_5";
    }

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
