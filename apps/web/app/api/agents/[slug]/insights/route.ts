import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, parseSearchParams } from "@/lib/api-utils";

const querySchema = z.object({
  type: z
    .enum(["CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"])
    .optional(),
  limit: z.string().optional(),
  page: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const agent = await prisma.agent.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  const parsed = parseSearchParams(request.url, querySchema);
  if ("error" in parsed) return parsed.error;
  const { data: query } = parsed;

  const page = Math.max(1, parseInt(query.page ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? "20", 10)));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    agentId: agent.id,
    status: "APPROVED",
  };
  if (query.type) {
    where.type = query.type;
  }

  const [contributions, total] = await Promise.all([
    prisma.knowledgeContribution.findMany({
      where,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        tags: true,
        usageCount: true,
        upvotes: true,
        downvotes: true,
        createdAt: true,
      },
      orderBy: { usageCount: "desc" },
      skip,
      take: limit,
    }),
    prisma.knowledgeContribution.count({ where }),
  ]);

  return jsonSuccess({ contributions, total, page, limit });
}
