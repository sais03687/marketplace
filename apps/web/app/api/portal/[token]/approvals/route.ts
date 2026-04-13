import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  const deployment = await prisma.deployment.findUnique({
    where: { portalToken: token },
    include: {
      agent: { select: { name: true, slug: true } },
    },
  });

  if (!deployment) {
    return jsonError("Invalid portal link", 404);
  }

  const approvals = await prisma.approval.findMany({
    where: {
      deploymentId: deployment.id,
      status: "PENDING",
    },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess({
    agentName: deployment.agentName,
    agentSlug: deployment.agent.slug,
    deploymentId: deployment.id,
    approvals,
  });
}
