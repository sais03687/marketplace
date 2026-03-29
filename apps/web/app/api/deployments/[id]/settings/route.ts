import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, parseBody, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

const settingsSchema = z.object({
  agentName: z.string().min(1).max(100).optional(),
  weeklyDigestEmail: z.string().email().optional(),
  autoUpdate: z.boolean().optional(),
  autonomyConfig: z.record(z.string()).optional(),
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

  const parsed = await parseBody(request, settingsSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const updateData: Record<string, unknown> = {};
  if (data.agentName !== undefined) updateData.agentName = data.agentName;
  if (data.weeklyDigestEmail !== undefined)
    updateData.weeklyDigestEmail = data.weeklyDigestEmail;
  if (data.autoUpdate !== undefined) updateData.autoUpdate = data.autoUpdate;
  if (data.autonomyConfig !== undefined)
    updateData.autonomyConfig = data.autonomyConfig;

  const updated = await prisma.deployment.update({
    where: { id },
    data: updateData,
  });

  return jsonSuccess(updated);
}
