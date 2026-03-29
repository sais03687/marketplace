import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const agent = await prisma.agent.findUnique({
    where: { slug },
    include: {
      capabilities: true,
      creator: {
        select: { displayName: true, email: true },
      },
      reviews: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  return jsonSuccess(agent);
}
