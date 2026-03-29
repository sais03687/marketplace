import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  parseBody,
  requireOrg,
} from "@/lib/api-utils";
import { Queue } from "bullmq";

const createDeploymentSchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1).max(100),
  roleTitle: z.string().optional(),
  weeklyDigestEmail: z.string().email().optional(),
  approvalManagerEmail: z.string().email().optional(),
  slackBotToken: z.string().optional(),
  slackAppToken: z.string().optional(),
});

let provisionQueue: Queue | null = null;
function getProvisionQueue() {
  if (!provisionQueue) {
    provisionQueue = new Queue("provisioning", {
      connection: {
        host: new URL(process.env.REDIS_URL || "redis://localhost:6379")
          .hostname,
        port: parseInt(
          new URL(process.env.REDIS_URL || "redis://localhost:6379").port ||
            "6379",
          10,
        ),
      },
    });
  }
  return provisionQueue;
}

export async function GET(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const url = new URL(request.url);
  const includeApprovals = url.searchParams.get("includeApprovals") === "true";

  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id },
    include: {
      agent: true,
      ...(includeApprovals ? { approvals: { orderBy: { createdAt: "desc" } } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess(deployments);
}

export async function POST(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const parsed = await parseBody(request, createDeploymentSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const agent = await prisma.agent.findUnique({
    where: { id: data.agentId },
  });

  if (!agent || agent.status !== "LIVE") {
    return jsonError("Agent not found or not available", 404);
  }

  const deployment = await prisma.deployment.create({
    data: {
      companyId: company.id,
      agentId: agent.id,
      agentVersion: agent.currentVersion || "1.0.0",
      agentName: data.agentName,
      weeklyDigestEmail: data.weeklyDigestEmail,
      slackBotToken: data.slackBotToken,
      slackAppToken: data.slackAppToken,
      autonomyConfig: {},
      status: "PROVISIONING",
    },
  });

  // Enqueue provision job (no Stripe gate)
  try {
    await getProvisionQueue().add("provision", {
      type: "provision",
      deploymentId: deployment.id,
    });
  } catch {
    // Queue may not be available in dev — mark as error
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: "ERROR" },
    });
    return jsonError("Failed to enqueue provisioning job", 503);
  }

  return jsonSuccess(deployment, 201);
}
