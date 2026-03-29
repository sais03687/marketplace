import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  jsonSuccess,
  parseBody,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;

  const scores = await prisma.trustScore.findMany({
    where: { deploymentId: id },
    orderBy: { lastUpdated: "desc" },
  });

  return jsonSuccess(scores);
}

const overrideSchema = z.object({
  taskType: z.string().min(1),
  autonomyLevel: z.enum([
    "always_queue",
    "queue_if_stakes_gt_5",
    "queue_if_stakes_gt_7",
    "auto_execute",
  ]),
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

  const parsed = await parseBody(request, overrideSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const score = await prisma.trustScore.upsert({
    where: {
      deploymentId_taskType: {
        deploymentId: id,
        taskType: data.taskType,
      },
    },
    create: {
      deploymentId: id,
      taskType: data.taskType,
      autonomyLevel: data.autonomyLevel,
    },
    update: {
      autonomyLevel: data.autonomyLevel,
      lastUpdated: new Date(),
    },
  });

  return jsonSuccess(score);
}
