import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, jsonError, parseSearchParams } from "@/lib/api-utils";

const searchSchema = z.object({
  agentId: z.string().min(1),
  deploymentId: z.string().min(1),
  q: z.string().optional(),
  type: z
    .enum(["CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"])
    .optional(),
  limit: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const parsed = parseSearchParams(request.url, searchSchema);
  if ("error" in parsed) return parsed.error;
  const { data: params } = parsed;

  // Validate deployment exists
  const deployment = await prisma.deployment.findUnique({
    where: { id: params.deploymentId },
  });
  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  // Reciprocity: only contributing deployments can search
  const ac = (deployment.autonomyConfig ?? {}) as Record<string, unknown>;
  if (ac.agentMindEnabled === false) {
    return jsonSuccess({ contributions: [] });
  }

  const limit = Math.min(50, Math.max(1, parseInt(params.limit ?? "10", 10)));

  const where: Record<string, unknown> = {
    agentId: params.agentId,
    status: "APPROVED",
  };

  if (params.type) {
    where.type = params.type;
  }

  if (params.q && params.q.trim()) {
    where.OR = [
      { title: { contains: params.q.trim(), mode: "insensitive" } },
      { content: { contains: params.q.trim(), mode: "insensitive" } },
      { tags: { has: params.q.trim().toLowerCase() } },
    ];
  }

  const contributions = await prisma.knowledgeContribution.findMany({
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
    take: limit,
  });

  // NOTE: usageCount is NOT incremented here — search is just browsing.
  // Agents call POST /api/agentmind/use with the IDs they actually
  // incorporated into a response, which increments usageCount + auto-upvotes.

  return jsonSuccess({ contributions });
}
