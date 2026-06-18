import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, parseBody, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { buildApprovalPolicySection } from "@/lib/approval-policy-prompt";

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

  // Hot-reload approval policy into the running container (best-effort).
  if (data.autonomyConfig && deployment.containerName) {
    try {
      const mergedAc = updateData.autonomyConfig as Record<string, unknown> | undefined;
      const runtime = deployment.agent.runtime || "OPENCLAW";

      if (runtime === "OPENCLAW") {
        // OpenClaw: rewrite AGENTS.md via internal API with rendered policy section
        const policySection = buildApprovalPolicySection(mergedAc, company.domain);
        const baseUrl = deployment.containerName.startsWith("http")
          ? deployment.containerName
          : `http://${deployment.containerName}:4000`;
        await fetch(`${baseUrl}/internal/approval-policy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policySection }),
        }).catch(() => {});
      } else {
        // CUSTOM: write approval_policy.json via adapter's internal API
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
          const baseUrl = deployment.containerName.startsWith("http")
            ? deployment.containerName
            : `http://${deployment.containerName}:4100`;
          await fetch(`${baseUrl}/internal/approval-policy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(override),
          }).catch(() => {});
        }
      }
    } catch {
      // best-effort; takes effect on next provision
    }
  }

  return jsonSuccess(updated);
}
