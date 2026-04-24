import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, requireAdmin, parseSearchParams } from "@/lib/api-utils";

const querySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin();
  if ("error" in authResult) return authResult.error;

  const parsed = parseSearchParams(request.url, querySchema);
  if ("error" in parsed) return parsed.error;
  const { data: params } = parsed;

  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(params.limit ?? "20", 10)));
  const skip = (page - 1) * limit;

  const [contributions, total] = await Promise.all([
    prisma.knowledgeContribution.findMany({
      where: { status: "PENDING" },
      include: {
        agent: { select: { name: true, slug: true } },
        deployment: { select: { agentName: true, companyId: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.knowledgeContribution.count({ where: { status: "PENDING" } }),
  ]);

  return jsonSuccess({ contributions, total, page, limit });
}
