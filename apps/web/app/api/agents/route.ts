import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, parseSearchParams } from "@/lib/api-utils";

const browseSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  modelTier: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  minRating: z.string().optional(),
  sort: z
    .enum(["popular", "rating", "newest", "price_asc", "price_desc"])
    .optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const parsed = parseSearchParams(request.url, browseSchema);
  if ("error" in parsed) return parsed.error;
  const { data: params } = parsed;

  const page = Math.max(1, parseInt(params.page ?? "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(params.limit ?? "12", 10)));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { status: "LIVE" };

  if (params.category) {
    where.category = params.category;
  }
  if (params.modelTier) {
    where.modelTier = params.modelTier;
  }
  if (params.minPrice || params.maxPrice) {
    where.pricePerMonth = {
      ...(params.minPrice ? { gte: parseInt(params.minPrice, 10) } : {}),
      ...(params.maxPrice ? { lte: parseInt(params.maxPrice, 10) } : {}),
    };
  }
  if (params.minRating) {
    where.averageRating = { gte: parseFloat(params.minRating) };
  }

  let orderBy: Record<string, string> = { createdAt: "desc" };
  switch (params.sort) {
    case "popular":
      orderBy = { totalDeployments: "desc" };
      break;
    case "rating":
      orderBy = { averageRating: "desc" };
      break;
    case "newest":
      orderBy = { createdAt: "desc" };
      break;
    case "price_asc":
      orderBy = { pricePerMonth: "asc" };
      break;
    case "price_desc":
      orderBy = { pricePerMonth: "desc" };
      break;
  }

  // Text search: if query provided, use tsvector search
  if (params.q && params.q.trim()) {
    const query = params.q.trim().replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).join(" & ");
    const agents = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT a.*,
        ts_rank(
          to_tsvector('english', a.name || ' ' || a.tagline || ' ' || a.description),
          to_tsquery('english', $1)
        ) as rank
       FROM "Agent" a
       WHERE a.status = 'LIVE'
         AND to_tsvector('english', a.name || ' ' || a.tagline || ' ' || a.description) @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2 OFFSET $3`,
      query,
      limit,
      skip,
    );

    const agentIds = agents.map((a) => a.id as string);
    const capabilities = await prisma.capability.findMany({
      where: { agentId: { in: agentIds } },
    });

    const enriched = agents.map((a) => ({
      ...a,
      capabilities: capabilities.filter((c) => c.agentId === a.id),
    }));

    return jsonSuccess({ agents: enriched, page, limit });
  }

  const [agents, total] = await Promise.all([
    prisma.agent.findMany({
      where,
      include: {
        capabilities: true,
        creator: { select: { displayName: true } },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.agent.count({ where }),
  ]);

  return jsonSuccess({ agents, total, page, limit });
}
