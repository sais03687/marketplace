import { prisma } from "@/lib/db";
import { generateReflection } from "@/lib/agentmind/reflect";

interface ResolveParams {
  approvalId: string;
  deploymentId: string;
  action: "APPROVED" | "EDITED" | "REJECTED";
  resolvedBy: string;
  editedText?: string;
  rejectionReason?: string;
  baseUrl?: string;
}

interface ResolveResult {
  approval: {
    id: string;
    status: string;
  };
  trustScore: {
    weightedScore: number;
    autonomyLevel: string;
  };
}

export async function resolveApprovalAndUpdateTrust(
  params: ResolveParams,
): Promise<ResolveResult> {
  const {
    approvalId,
    deploymentId,
    action,
    resolvedBy,
    editedText,
    rejectionReason,
    baseUrl,
  } = params;

  // Compute edit diff if edited
  let editDiff: string | null = null;
  if (action === "EDITED" && editedText) {
    editDiff = editedText;
  }

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, deploymentId },
  });

  if (!approval) {
    throw new Error("Approval not found");
  }

  const updated = await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: action,
      resolvedBy,
      resolutionAction: editedText ?? null,
      editDiff,
      rejectionReason: rejectionReason ?? null,
      resolvedAt: new Date(),
    },
  });

  // Update trust score
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
      approvedNoEdit: action === "APPROVED" ? 1 : 0,
      edited: action === "EDITED" ? 1 : 0,
      rejected: action === "REJECTED" ? 1 : 0,
    },
    update: {
      approvedNoEdit:
        action === "APPROVED" ? { increment: 1 } : undefined,
      edited: action === "EDITED" ? { increment: 1 } : undefined,
      rejected: action === "REJECTED" ? { increment: 1 } : undefined,
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

  // Notify container (fire-and-forget)
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { containerName: true },
  });

  if (deployment?.containerName) {
    try {
      const containerUrl = deployment.containerName.startsWith("http")
        ? deployment.containerName
        : `http://${deployment.containerName}:4100`;
      await fetch(`${containerUrl}/internal/resolve-approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId,
          action,
          editedText,
          rejectionReason,
        }),
      });
    } catch {
      // Container may be unreachable
    }
  }

  // AgentMind reflection (fire-and-forget)
  if (action === "EDITED" || action === "REJECTED") {
    const reflectBaseUrl =
      baseUrl || `http://localhost:${process.env.PORT || 3002}`;
    generateReflection({
      originalDraft: approval.draft || "",
      editedText: action === "EDITED" ? editedText : undefined,
      rejectionReason: action === "REJECTED" ? rejectionReason : undefined,
      taskType: approval.taskType,
      originalRequest: (approval as any).originalRequest || "",
    })
      .then((reflection) =>
        fetch(`${reflectBaseUrl}/api/agentmind/contribute`, {
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
        // Non-fatal
      });
  }

  return {
    approval: { id: updated.id, status: updated.status },
    trustScore: { weightedScore: score, autonomyLevel },
  };
}
