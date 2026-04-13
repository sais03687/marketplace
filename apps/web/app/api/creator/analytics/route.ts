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
  }> = [];

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
    });
  }

  // Get approval rate across all deployments
  const deploymentIds = creator.agents.flatMap((a) =>
    a.deployments.map((d) => d.id),
  );

  if (deploymentIds.length > 0) {
    approvedApprovals = await prisma.approval.count({
      where: {
        deploymentId: { in: deploymentIds },
        status: "APPROVED",
      },
    });
  }

  const approvalRate =
    totalApprovals > 0 ? approvedApprovals / totalApprovals : 0;

  return jsonSuccess({
    totalDeployments,
    activeDeployments,
    mrr,
    approvalRate,
    totalApprovals,
    perAgent,
  });
}
