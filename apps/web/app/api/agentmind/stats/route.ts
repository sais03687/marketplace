import { prisma } from "@/lib/db";
import { jsonSuccess, requireOrg } from "@/lib/api-utils";

export async function GET() {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id },
    select: { id: true },
  });
  const deploymentIds = deployments.map((d) => d.id);

  const [total, approved, pending, rejected] = await Promise.all([
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds } },
    }),
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds }, status: "APPROVED" },
    }),
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds }, status: "PENDING" },
    }),
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds }, status: "REJECTED" },
    }),
  ]);

  const usageAgg = await prisma.knowledgeContribution.aggregate({
    where: { deploymentId: { in: deploymentIds }, status: "APPROVED" },
    _sum: { usageCount: true, upvotes: true },
  });

  return jsonSuccess({
    total,
    approved,
    pending,
    rejected,
    totalUsage: usageAgg._sum.usageCount ?? 0,
    totalUpvotes: usageAgg._sum.upvotes ?? 0,
  });
}
