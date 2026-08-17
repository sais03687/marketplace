import { z } from "zod";
import { AUTONOMY_LEVELS, clampManualAutonomy } from "@/lib/autonomy";
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
  autonomyLevel: z.enum(AUTONOMY_LEVELS),
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

  // A question always reaches a human, including when the buyer sets the level
  // by hand. Every level above always_queue means the same thing on a question:
  // the agent asks and nobody answers.
  const autonomyLevel = clampManualAutonomy(data.taskType, data.autonomyLevel);

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
      autonomyLevel,
    },
    update: {
      autonomyLevel,
      lastUpdated: new Date(),
    },
  });

  return jsonSuccess(score);
}
