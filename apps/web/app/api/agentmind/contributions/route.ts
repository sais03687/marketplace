import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, requireOrg, parseSearchParams } from "@/lib/api-utils";

const querySchema = z.object({
  status: z
    .enum(["PENDING", "APPROVED", "REJECTED"])
    .optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const parsed = parseSearchParams(request.url, querySchema);
  if ("error" in parsed) return parsed.error;
  const { data: params } = parsed;

  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(params.limit ?? "20", 10)));
  const skip = (page - 1) * limit;

  // Get AgentMind-enabled deployment IDs for this company
  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id },
    select: { id: true, autonomyConfig: true },
  });
  const deploymentIds = deployments
    .filter((d) => {
      const ac = (d.autonomyConfig ?? {}) as Record<string, unknown>;
      return ac.agentMindEnabled !== false;
    })
    .map((d) => d.id);

  const where: Record<string, unknown> = {
    deploymentId: { in: deploymentIds },
  };
  if (params.status) {
    where.status = params.status;
  }

  const [contributions, total] = await Promise.all([
    prisma.knowledgeContribution.findMany({
      where,
      include: {
        deployment: { select: { agentName: true } },
        agent: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.knowledgeContribution.count({ where }),
  ]);

  return jsonSuccess({ contributions, total, page, limit });
}
