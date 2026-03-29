import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { generateReflection } from "@/lib/agentmind/reflect";

/**
 * PATCH handler for agent-originated approval resolution.
 * Called by the agentmail-tools plugin's resolve_approval tool.
 * No Clerk auth — this is an internal agent-to-marketplace call.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id: deploymentId, approvalId } = await params;

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, deploymentId },
  });

  if (!approval) {
    return jsonError("Approval not found", 404);
  }

  if (approval.status !== "PENDING") {
    return jsonError("Approval already resolved", 409);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const { status, note } = body as Record<string, unknown>;
  const statusStr = String(status || "").toUpperCase();

  const actionMap: Record<string, string> = {
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    EDITED: "EDITED",
  };
  const mappedStatus = actionMap[statusStr];
  if (!mappedStatus) {
    return jsonError("status must be approved, rejected, or edited", 400);
  }

  const updated = await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: mappedStatus as any,
      resolvedBy: "agent",
      resolutionAction: note ? String(note) : null,
      resolvedAt: new Date(),
    },
  });

  // Update trust score (mirrors the UI resolve endpoint logic)
  const trustScore = await prisma.trustScore.upsert({
    where: {
      deploymentId_taskType: {
        deploymentId,
        taskType: approval.taskType,
      },
    },
    create: {
      deploymentId,
      taskType: approval.taskType,
      approvedNoEdit: mappedStatus === "APPROVED" ? 1 : 0,
      edited: mappedStatus === "EDITED" ? 1 : 0,
      rejected: mappedStatus === "REJECTED" ? 1 : 0,
    },
    update: {
      approvedNoEdit:
        mappedStatus === "APPROVED" ? { increment: 1 } : undefined,
      edited: mappedStatus === "EDITED" ? { increment: 1 } : undefined,
      rejected: mappedStatus === "REJECTED" ? { increment: 1 } : undefined,
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

  // Auto-contribute to AgentMind on EDITED/REJECTED (fire-and-forget)
  if (mappedStatus === "EDITED" || mappedStatus === "REJECTED") {
    const baseUrl = `http://localhost:${process.env.PORT || 3002}`;

    generateReflection({
      originalDraft: approval.draft || "",
      editedText: mappedStatus === "EDITED" ? String(note || "") : undefined,
      rejectionReason: mappedStatus === "REJECTED" ? String(note || "") : undefined,
      taskType: approval.taskType,
      originalRequest: (approval as any).originalRequest || "",
    })
      .then((reflection) =>
        fetch(`${baseUrl}/api/agentmind/contribute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deploymentId,
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

  return jsonSuccess({ approval: { id: updated.id, status: updated.status } });
}
