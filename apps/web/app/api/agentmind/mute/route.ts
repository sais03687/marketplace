import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { z } from "zod";

/**
 * Silence one commons lesson for one deployment.
 *
 * AgentMind is shared across every deployment of an agent — search filters on
 * agentId, not deploymentId — so a lesson written by one buyer's agent is
 * retrieved by all of them. Deleting is company-scoped and returns 403 to anyone
 * else, which is correct isolation but left a buyer whose agent was being misled
 * by somebody else's lesson with no remedy at all short of disabling AgentMind
 * entirely.
 *
 * This is that remedy, and it stops at the deployment: one buyer's judgement
 * cannot remove another buyer's knowledge. It is deliberately the last line of
 * defence rather than the first — clustering and provenance checks at contribute
 * time, plus outcome tracking at runtime, are what catch harmful lessons without
 * anybody having to notice. Repeated mutes across deployments are strong evidence
 * for an admin to remove a lesson from the commons outright.
 */
const bodySchema = z.object({
  deploymentId: z.string().min(1),
  contributionId: z.string().min(1),
  reason: z.string().max(500).optional(),
  muted: z.boolean().default(true),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("Invalid request: deploymentId and contributionId required", 400);
  }
  const { deploymentId, contributionId, reason, muted } = parsed.data;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const access = await requireDeploymentAccess(deploymentId, orgResult.company.id);
  if ("error" in access) return access.error;

  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id: contributionId },
    select: { id: true },
  });
  if (!contribution) return jsonError("Contribution not found", 404);

  if (!muted) {
    await prisma.contributionMute.deleteMany({ where: { contributionId, deploymentId } });
    return jsonSuccess({ muted: false });
  }

  // Idempotent: muting twice is not an error, it is the same intent stated again.
  await prisma.contributionMute.upsert({
    where: { contributionId_deploymentId: { contributionId, deploymentId } },
    create: { contributionId, deploymentId, reason: reason || null },
    update: { reason: reason || null },
  });

  console.log(
    `[agentmind] Deployment ${deploymentId.slice(0, 8)} muted contribution ${contributionId.slice(0, 8)}` +
      (reason ? `: ${reason}` : ""),
  );
  return jsonSuccess({ muted: true });
}
