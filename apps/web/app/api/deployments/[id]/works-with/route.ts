import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, parseBody, requireDeploymentAccess, requireOrg } from "@/lib/api-utils";
import { idsOf, setWorksWith } from "@/lib/teammates";

const schema = z.object({ worksWith: z.array(z.string()).max(50) });

/**
 * GET — this hire's other agents to choose from, and which it works with now.
 * PATCH — { worksWith: deploymentId[] }: both sides of each link are updated.
 * Agents pick a change up the next time they check who may mail them, within
 * about a minute; nothing is rebuilt.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const access = await requireDeploymentAccess(id, orgResult.company.id);
  if ("error" in access) return access.error;

  const others = await prisma.deployment.findMany({
    where: {
      companyId: orgResult.company.id,
      id: { not: id },
      status: { notIn: ["FIRED", "PENDING_PAYMENT"] },
    },
    select: { id: true, agentName: true, status: true, agent: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return jsonSuccess({
    options: others.map((d) => ({ id: d.id, name: d.agentName, agent: d.agent.name, status: d.status })),
    worksWith: idsOf(access.deployment.worksWith),
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const access = await requireDeploymentAccess(id, orgResult.company.id);
  if ("error" in access) return access.error;

  const parsed = await parseBody(request, schema);
  if ("error" in parsed) return parsed.error;

  const kept = await setWorksWith(prisma, orgResult.company.id, id, parsed.data.worksWith);
  return jsonSuccess({ worksWith: kept });
}
