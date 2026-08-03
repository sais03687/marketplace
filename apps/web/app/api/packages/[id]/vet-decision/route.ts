import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { sendNotificationEmail, buildVettingDecisionEmail } from "@/lib/email";
import { Queue } from "bullmq";

let provisioningQueue: Queue | null = null;
function getProvisioningQueue() {
  if (!provisioningQueue) {
    provisioningQueue = new Queue("provisioning", {
      connection: {
        host: new URL(process.env.REDIS_URL || "redis://localhost:6379").hostname,
        port: parseInt(
          new URL(process.env.REDIS_URL || "redis://localhost:6379").port || "6379",
          10,
        ),
      },
    });
  }
  return provisioningQueue;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;

  let decision: string;

  const contentType = request.headers.get("content-type") || "";
  let feedback = "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    decision = body.decision;
    feedback = body.feedback ?? "";
  } else {
    const formData = await request.formData();
    decision = formData.get("decision") as string;
    feedback = (formData.get("feedback") as string) ?? "";
  }

  if (!decision || !["MANUALLY_APPROVED", "FAILED", "PASSED"].includes(decision)) {
    return jsonError("Invalid decision", 400);
  }

  // Include creator so we can email them
  const version = await prisma.agentVersion.findUnique({
    where: { id },
    include: {
      agent: {
        include: { creator: true },
      },
    },
  });

  if (!version) {
    return jsonError("Version not found", 404);
  }

  await prisma.agentVersion.update({
    where: { id },
    data: {
      vetStatus: decision as "MANUALLY_APPROVED" | "FAILED" | "PASSED",
      vetNotes: feedback || (decision === "FAILED" ? "Rejected by admin" : null),
      publishedAt: decision === "MANUALLY_APPROVED" ? new Date() : null,
    },
  });

  // ── Email creator ──────────────────────────────────────────────────────────
  const platformInboxId = process.env.PLATFORM_NOTIFICATION_INBOX_ID;
  if (platformInboxId) {
    const { subject, html } = buildVettingDecisionEmail({
      agentName: version.agent.name,
      version: version.version,
      decision: decision as "MANUALLY_APPROVED" | "FAILED" | "PASSED",
      feedback: feedback || undefined,
    });
    // Awaited despite costing a little latency: not blocking the response means
    // the send is cancelled with the function on Vercel, and a creator who is
    // never told their package was rejected is worse than a slower request.
    await sendNotificationEmail({
      inboxId: platformInboxId,
      to: version.agent.creator.email,
      subject,
      html,
    });
  }

  // ── If approved: update agent + trigger auto-updates ──────────────────────
  if (decision === "MANUALLY_APPROVED") {
    const updateData: Record<string, unknown> = {
      status: "LIVE",
      currentVersion: version.version,
    };

    // Extract capabilities from manifest
    if (version.manifestData) {
      const manifest = version.manifestData as Record<string, unknown>;
      const capabilities = manifest.capabilities as
        | Array<{ name: string; description: string }>
        | undefined;
      if (capabilities && capabilities.length > 0) {
        await prisma.capability.deleteMany({ where: { agentId: version.agentId } });
        await prisma.capability.createMany({
          data: capabilities.map((cap) => ({
            agentId: version.agentId,
            name: cap.name,
            description: cap.description,
          })),
        });
      }
    }

    // Extract onboarding data from blob
    if (version.storagePath) {
      try {
        const { readPackageFile } = await import("@/lib/package-storage");
        const questionsBuffer = await readPackageFile(version.storagePath, "onboarding/questions.json");
        if (questionsBuffer) {
          updateData.onboardingQuestions = JSON.parse(questionsBuffer.toString("utf-8"));
        }
        const memoryBuffer = await readPackageFile(version.storagePath, "onboarding/MEMORY_TEMPLATE.md");
        if (memoryBuffer) {
          updateData.memoryTemplate = memoryBuffer.toString("utf-8");
        }
      } catch {
        // Non-fatal
      }
    }

    await prisma.agent.update({
      where: { id: version.agentId },
      data: updateData,
    });

    // Mark all other PENDING versions of this agent as superseded
    await prisma.agentVersion.updateMany({
      where: {
        agentId: version.agentId,
        vetStatus: "PENDING",
        id: { not: version.id },
      },
      data: {
        vetStatus: "FAILED",
        vetNotes: "Superseded by approved version",
      },
    });

    const queue = getProvisioningQueue();
    const stripe = getStripe();

    // ── Auto-resume deployments paused due to version removal ────────────────
    const pausedDeployments = await prisma.deployment.findMany({
      where: {
        agentId: version.agentId,
        status: "PAUSED",
        pauseReason: { not: null },
      },
    });

    if (pausedDeployments.length > 0) {
      await Promise.all(
        pausedDeployments.map(async (dep) => {
          await prisma.deployment.update({
            where: { id: dep.id },
            data: { status: "ACTIVE", agentVersion: version.version, pauseReason: null },
          });
          try {
            await queue.add("resume", { type: "resume", deploymentId: dep.id });
          } catch (err: any) {
            console.warn(`[vet-decision] resume enqueue failed for ${dep.id}:`, err.message);
          }
          if (dep.stripeSubscriptionId && stripe) {
            try {
              await stripe.subscriptions.update(dep.stripeSubscriptionId, {
                pause_collection: "",
              } as any);
            } catch (err: any) {
              console.warn(`[vet-decision] Stripe resume failed for ${dep.stripeSubscriptionId}:`, err.message);
            }
          }
        }),
      );
      console.log(`[vet-decision] Auto-resumed ${pausedDeployments.length} paused deployment(s)`);
    }

    // ── Auto-update active deployments with autoUpdate: true ─────────────────
    const autoUpdateDeployments = await prisma.deployment.findMany({
      where: {
        agentId: version.agentId,
        status: "ACTIVE",
        autoUpdate: true,
        agentVersion: { not: version.version },
      },
    });

    if (autoUpdateDeployments.length > 0) {
      await Promise.all(
        autoUpdateDeployments.map(async (dep) => {
          // Update version in DB so the container knows what to pull
          await prisma.deployment.update({
            where: { id: dep.id },
            data: { agentVersion: version.version },
          });
          try {
            await queue.add("update", { type: "update", deploymentId: dep.id });
          } catch (err: any) {
            console.warn(`[vet-decision] update enqueue failed for ${dep.id}:`, err.message);
          }
        }),
      );
      console.log(`[vet-decision] Auto-update queued for ${autoUpdateDeployments.length} deployment(s)`);
    }
  }

  return jsonSuccess({ message: `Decision: ${decision}` });
}
