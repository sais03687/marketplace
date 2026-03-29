import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  parseBody,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";
import { generateReflection } from "@/lib/agentmind/reflect";

const resolveSchema = z.object({
  action: z.enum(["APPROVED", "EDITED", "REJECTED"]),
  editedText: z.string().optional(),
  rejectionReason: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id, approvalId } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { userId, company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  const parsed = await parseBody(request, resolveSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, deploymentId: id },
  });

  if (!approval) {
    return jsonError("Approval not found", 404);
  }

  if (approval.status !== "PENDING") {
    return jsonError("Approval already resolved", 409);
  }

  // Compute edit diff if edited
  let editDiff: string | null = null;
  if (data.action === "EDITED" && data.editedText) {
    editDiff = data.editedText;
  }

  const updated = await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: data.action,
      resolvedBy: userId,
      resolutionAction: data.editedText ?? null,
      editDiff,
      rejectionReason: data.rejectionReason ?? null,
      resolvedAt: new Date(),
    },
  });

  // Update trust score
  const trustScore = await prisma.trustScore.upsert({
    where: {
      deploymentId_taskType: {
        deploymentId: id,
        taskType: approval.taskType,
      },
    },
    create: {
      deploymentId: id,
      taskType: approval.taskType,
      approvedNoEdit: data.action === "APPROVED" ? 1 : 0,
      edited: data.action === "EDITED" ? 1 : 0,
      rejected: data.action === "REJECTED" ? 1 : 0,
    },
    update: {
      approvedNoEdit:
        data.action === "APPROVED" ? { increment: 1 } : undefined,
      edited: data.action === "EDITED" ? { increment: 1 } : undefined,
      rejected: data.action === "REJECTED" ? { increment: 1 } : undefined,
      lastUpdated: new Date(),
    },
  });

  // Recalculate weighted score
  const total =
    trustScore.approvedNoEdit + trustScore.edited + trustScore.rejected;
  const score = total > 0 ? trustScore.approvedNoEdit / total : 0;

  let autonomyLevel = "always_queue";
  if (score >= 0.95 && total >= 20) autonomyLevel = "auto_execute";
  else if (score >= 0.8) autonomyLevel = "queue_if_stakes_gt_7";
  else if (score >= 0.6) autonomyLevel = "queue_if_stakes_gt_5";

  await prisma.trustScore.update({
    where: { id: trustScore.id },
    data: { weightedScore: score, autonomyLevel },
  });

  // POST resolution to container internal API
  if (deployment.containerName) {
    try {
      const containerUrl =
        deployment.containerName.startsWith("http")
          ? deployment.containerName
          : `http://${deployment.containerName}:4100`;
      await fetch(`${containerUrl}/internal/resolve-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId,
          action: data.action,
          editedText: data.editedText,
          rejectionReason: data.rejectionReason,
        }),
      });
    } catch {
      // Container may be unreachable — resolution is saved in DB
    }
  }

  // Auto-contribute to AgentMind on EDITED/REJECTED (fire-and-forget)
  if (data.action === "EDITED" || data.action === "REJECTED") {
    const origin = request.headers.get("origin") || request.headers.get("referer")?.replace(/\/[^/]*$/, "") || "";
    const baseUrl = origin || `http://localhost:${process.env.PORT || 3002}`;

    generateReflection({
      originalDraft: approval.draft || "",
      editedText: data.action === "EDITED" ? data.editedText : undefined,
      rejectionReason: data.action === "REJECTED" ? data.rejectionReason : undefined,
      taskType: approval.taskType,
      originalRequest: (approval as any).originalRequest || "",
    })
      .then((reflection) =>
        fetch(`${baseUrl}/api/agentmind/contribute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deploymentId: id,
            type: "CORRECTION",
            title: reflection.title,
            content: reflection.content,
            tags: reflection.tags,
          }),
        }),
      )
      .catch(() => {
        // Non-fatal — AgentMind reflection + contribution is best-effort
      });
  }

  return jsonSuccess(updated);
}
