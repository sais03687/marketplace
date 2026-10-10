import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, parseBody, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { getProvisioningQueue } from "@/lib/provisioning-queue";
import { acceptsAll, hostsOfVersion } from "@/lib/connects-to";
import { addedHosts } from "@marketplace/agent-package-schema";

const bodySchema = z.object({
  // Required only when the newer version reaches outside sites this hire's
  // version did not; the buyer accepts exactly that list.
  acceptedHosts: z.array(z.string()).max(20).optional(),
});

/**
 * POST /api/deployments/[id]/update — apply the agent's newest approved version now.
 *
 * The buyer's way to update by hand. Until this existed, a hire with
 * auto-update off showed "Update available" with no way to take it, and one
 * with auto-update on was told it would be applied — which, for a hire still
 * being set up when the version was approved, nothing ever did.
 *
 * It is also the only way a version that adds outside sites reaches a hire:
 * auto-update skips those, and this route applies one only when the buyer has
 * accepted every new site.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  const parsed = await parseBody(request, bodySchema);
  if ("error" in parsed) return parsed.error;

  if (deployment.status !== "ACTIVE" && deployment.status !== "ONBOARDING") {
    return jsonError("Only an active agent can be updated", 409);
  }

  const agent = await prisma.agent.findUnique({
    where: { id: deployment.agentId },
    select: { currentVersion: true },
  });
  const target = agent?.currentVersion;
  if (!target || target === deployment.agentVersion) {
    return jsonError("This agent is already on the newest version", 409);
  }

  const newHosts = addedHosts(
    await hostsOfVersion(deployment.agentId, deployment.agentVersion),
    await hostsOfVersion(deployment.agentId, target),
  );
  if (!acceptsAll(newHosts, parsed.data.acceptedHosts)) {
    return jsonError(
      `Version ${target} connects to new outside sites (${newHosts.join(", ")}). Accept them to update.`,
      400,
    );
  }

  const previous = deployment.agentVersion;
  await prisma.deployment.update({ where: { id }, data: { agentVersion: target } });
  try {
    await getProvisioningQueue().add("update", { type: "update", deploymentId: id } as any);
  } catch (err: any) {
    // Put it back: the dashboard must not claim a version the agent is not running.
    await prisma.deployment.update({ where: { id }, data: { agentVersion: previous } });
    console.error(`[update-route] Could not queue the update for ${id}: ${err.message}`);
    return jsonError("Could not start the update. Nothing has changed — please try again.", 503);
  }

  console.log(
    `[update-route] ${id}: ${previous} -> ${target}` +
      (newHosts.length ? ` (buyer accepted outside sites: ${newHosts.join(", ")})` : ""),
  );
  return jsonSuccess({ message: `Updating to ${target}`, version: target });
}
