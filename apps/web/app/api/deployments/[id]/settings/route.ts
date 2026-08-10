import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, parseBody, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { pushApprovalPolicy } from "@/lib/approval-policy";

const autonomyConfigSchema = z
  .object({
    approvalPolicy: z.enum(["always", "external-only", "risk-based", "never"]).optional(),
    approvalRiskThreshold: z.number().min(1).max(10).optional(),
    autoApproveList: z.array(z.string()).optional(),
    requireApprovalList: z.array(z.string()).optional(),
    agentMindEnabled: z.boolean().optional(),
    agentMindAutoApprove: z.boolean().optional(),
  })
  .passthrough();

const settingsSchema = z.object({
  agentName: z.string().min(1).max(100).optional(),
  managerEmail: z.string().email().optional(),
  autoUpdate: z.boolean().optional(),
  autonomyConfig: autonomyConfigSchema.optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  const parsed = await parseBody(request, settingsSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const updateData: Record<string, unknown> = {};
  if (data.agentName !== undefined) updateData.agentName = data.agentName;
  if (data.managerEmail !== undefined)
    updateData.managerEmail = data.managerEmail;
  if (data.autoUpdate !== undefined) updateData.autoUpdate = data.autoUpdate;
  if (data.autonomyConfig !== undefined) {
    // Merge with existing so partial updates don't wipe other keys.
    updateData.autonomyConfig = {
      ...((deployment.autonomyConfig as Record<string, unknown>) ?? {}),
      ...data.autonomyConfig,
    };
  }

  const updated = await prisma.deployment.update({
    where: { id },
    data: updateData,
  });

  // Push the changed approval policy into the running container.
  //
  // This used to POST deployment.containerName directly — "http://localhost:32793",
  // an address that means the VPS. This route runs on Vercel, where localhost is
  // Vercel's own loopback, so the call could never arrive; and it was wrapped in
  // .catch(() => {}), so nobody ever found out. The settings page reported
  // success while the running agent kept the old policy until its next provision.
  //
  // A policy that says "always ask" on screen and "never ask" in the container is
  // the wrong way round to be silent about, so the result is now reported.
  let policyApplied: boolean | undefined;
  if (data.autonomyConfig && deployment.containerName) {
    const ac = data.autonomyConfig;
    const override: Record<string, unknown> = {};
    if (ac.approvalPolicy) override.policy = ac.approvalPolicy;
    if (typeof ac.approvalRiskThreshold === "number")
      override.riskThreshold = ac.approvalRiskThreshold;
    if (Array.isArray(ac.autoApproveList))
      override.autoApprove = ac.autoApproveList;
    if (Array.isArray(ac.requireApprovalList))
      override.requireApproval = ac.requireApprovalList;

    if (Object.keys(override).length > 0) {
      policyApplied = await pushApprovalPolicy(deployment.containerName, override);
    }
  }

  // The stored settings are authoritative and were saved; policyApplied says
  // whether the agent already running has picked them up. When it has not, the
  // change lands at the next provision — true either way, but the caller should
  // be able to tell the difference rather than assuming the stronger one.
  return jsonSuccess(
    policyApplied === undefined ? updated : { ...updated, policyApplied },
  );
}
