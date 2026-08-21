import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

export async function GET() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
    include: {
      agents: {
        include: {
          _count: {
            select: { deployments: true },
          },
          deployments: {
            select: {
              id: true,
              status: true,
              _count: {
                select: { approvals: true },
              },
            },
          },
        },
      },
    },
  });

  if (!creator) {
    return jsonError("Creator not found", 404);
  }

  let totalDeployments = 0;
  let activeDeployments = 0;
  let mrr = 0;
  let totalApprovals = 0;
  let approvedApprovals = 0;

  const perAgent: Array<{
    slug: string;
    name: string;
    activeDeployments: number;
    totalDeployments: number;
    mrr: number;
    approvalCount: number;
    outcomes: { approved: number; edited: number; rejected: number; expired: number; pending: number };
    topRejectedTasks: Array<{ taskType: string; count: number }>;
  }> = [];

  // Map each deployment back to the agent that owns it, so a single flat query of
  // approval outcomes can be attributed per agent without one query per agent.
  const depToAgentSlug = new Map<string, string>();
  for (const agent of creator.agents) {
    for (const dep of agent.deployments) depToAgentSlug.set(dep.id, agent.slug);
  }

  for (const agent of creator.agents) {
    let agentActive = 0;
    let agentTotal = agent._count.deployments;
    let agentApprovals = 0;

    totalDeployments += agentTotal;

    for (const dep of agent.deployments) {
      agentApprovals += dep._count.approvals;
      totalApprovals += dep._count.approvals;

      if (dep.status === "ACTIVE" || dep.status === "ONBOARDING") {
        agentActive++;
        activeDeployments++;
        mrr += agent.pricePerMonth;
      }
    }

    perAgent.push({
      slug: agent.slug,
      name: agent.name,
      activeDeployments: agentActive,
      totalDeployments: agentTotal,
      mrr: agent.pricePerMonth * agentActive,
      approvalCount: agentApprovals,
      outcomes: { approved: 0, edited: 0, rejected: 0, expired: 0, pending: 0 },
      topRejectedTasks: [] as Array<{ taskType: string; count: number }>,
    });
  }

  // Get approval rate and outcome breakdown across all deployments in ONE query.
  // We select only deploymentId, status and taskType - never draft, reasoning,
  // rejectionReason or any buyer-authored free text. Those belong to the buyer's
  // tenant; a creator seeing "buyers rejected drive_upload 4x" is useful feedback,
  // a creator reading the buyer's reason for rejecting is a cross-tenant leak.
  const deploymentIds = creator.agents.flatMap((a) =>
    a.deployments.map((d) => d.id),
  );

  const overall = { approved: 0, edited: 0, rejected: 0, expired: 0, pending: 0 };
  const perAgentBySlug = new Map(perAgent.map((a) => [a.slug, a]));
  // agent slug -> (taskType -> rejection count)
  const rejectedTasks = new Map<string, Map<string, number>>();

  if (deploymentIds.length > 0) {
    const rows = await prisma.approval.findMany({
      where: { deploymentId: { in: deploymentIds } },
      select: { deploymentId: true, status: true, taskType: true },
    });
    for (const r of rows) {
      const bucket =
        r.status === "APPROVED" ? "approved"
        : r.status === "EDITED" ? "edited"
        : r.status === "REJECTED" ? "rejected"
        : r.status === "EXPIRED" ? "expired"
        : "pending";
      overall[bucket as keyof typeof overall]++;
      if (bucket === "approved") approvedApprovals++;

      const slug = depToAgentSlug.get(r.deploymentId);
      if (!slug) continue;
      const agentRow = perAgentBySlug.get(slug);
      if (agentRow) agentRow.outcomes[bucket as keyof typeof agentRow.outcomes]++;

      if (bucket === "rejected") {
        if (!rejectedTasks.has(slug)) rejectedTasks.set(slug, new Map());
        const m = rejectedTasks.get(slug)!;
        m.set(r.taskType, (m.get(r.taskType) || 0) + 1);
      }
    }
  }

  // Attach the 3 most-rejected task types per agent, so a creator can see WHICH
  // kind of action buyers push back on - the actionable half of the feedback.
  for (const [slug, m] of rejectedTasks) {
    const agentRow = perAgentBySlug.get(slug);
    if (!agentRow) continue;
    agentRow.topRejectedTasks = [...m.entries()]
      .map(([taskType, count]) => ({ taskType, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
  }

  const approvalRate =
    totalApprovals > 0 ? approvedApprovals / totalApprovals : 0;

  return jsonSuccess({
    totalDeployments,
    activeDeployments,
    mrr,
    approvalRate,
    totalApprovals,
    outcomes: overall,
    perAgent,
  });
}
