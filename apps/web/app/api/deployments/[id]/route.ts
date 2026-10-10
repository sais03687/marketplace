import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";
import { redactSecrets } from "@/lib/redact";
import { hostsOfVersion } from "@/lib/connects-to";
import { addedHosts } from "@marketplace/agent-package-schema";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const deployment = await prisma.deployment.findFirst({
    where: { id, companyId: company.id },
    include: {
      agent: {
        include: { capabilities: true },
      },
      _count: {
        select: {
          approvals: { where: { status: "PENDING" } },
        },
      },
    },
  });

  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  const updateAvailable =
    deployment.agent.currentVersion !== null &&
    deployment.agentVersion !== deployment.agent.currentVersion;

  // Outside sites the newer version reaches that this hire's version does not.
  // Non-empty means the update waits for the buyer to accept them.
  const updateNewHosts = updateAvailable
    ? addedHosts(
        await hostsOfVersion(deployment.agentId, deployment.agentVersion),
        await hostsOfVersion(deployment.agentId, deployment.agent.currentVersion),
      )
    : [];

  // Why setup failed, for the panel that offers to retry it. Every step already
  // writes here; the buyer has never been shown any of it, which is how a hire
  // that failed looked exactly like one that worked.
  const lastFailure =
    deployment.status === "ERROR"
      ? await prisma.provisioningLog.findFirst({
          where: { deploymentId: id, status: "failed" },
          orderBy: { createdAt: "desc" },
          select: { message: true, step: true, createdAt: true },
        })
      : null;

  const payload = {
    ...deployment,
    updateAvailable,
    updateNewHosts,
    lastFailure: lastFailure
      ? { step: lastFailure.step, message: lastFailure.message, at: lastFailure.createdAt }
      : null,
  };

  return jsonSuccess(redactSecrets(payload));
}
