import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
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

  // In production, check admin role
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

  const version = await prisma.agentVersion.findUnique({
    where: { id },
    include: { agent: true },
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

  // If approved, set agent to LIVE and update currentVersion + onboarding data
  if (decision === "MANUALLY_APPROVED") {
    const updateData: Record<string, unknown> = {
      status: "LIVE",
      currentVersion: version.version,
    };

    // If the version has manifest data, extract onboarding fields
    if (version.manifestData) {
      const manifest = version.manifestData as Record<string, unknown>;

      // Update capabilities from manifest
      const capabilities = manifest.capabilities as
        | Array<{ name: string; description: string }>
        | undefined;
      if (capabilities && capabilities.length > 0) {
        await prisma.capability.deleteMany({
          where: { agentId: version.agentId },
        });
        await prisma.capability.createMany({
          data: capabilities.map((cap) => ({
            agentId: version.agentId,
            name: cap.name,
            description: cap.description,
          })),
        });
      }
    }

    // If the version has stored package files, try to extract onboarding data
    if (version.storagePath) {
      try {
        const { readPackageFile } = await import("@/lib/package-storage");
        const questionsBuffer = await readPackageFile(
          version.storagePath,
          "onboarding/questions.json",
        );
        if (questionsBuffer) {
          updateData.onboardingQuestions = JSON.parse(
            questionsBuffer.toString("utf-8"),
          );
        }
        const memoryBuffer = await readPackageFile(
          version.storagePath,
          "onboarding/MEMORY_TEMPLATE.md",
        );
        if (memoryBuffer) {
          updateData.memoryTemplate = memoryBuffer.toString("utf-8");
        }
      } catch {
        // Non-fatal: onboarding data extraction is best-effort
      }
    }

    await prisma.agent.update({
      where: { id: version.agentId },
      data: updateData,
    });

    // Auto-resume any deployments that were paused due to a previous version removal
    const pausedDeployments = await prisma.deployment.findMany({
      where: {
        agentId: version.agentId,
        status: "PAUSED",
        pauseReason: { not: null },
      },
    });

    if (pausedDeployments.length > 0) {
      const queue = getProvisioningQueue();
      const stripe = getStripe();

      await Promise.all(
        pausedDeployments.map(async (dep) => {
          await prisma.deployment.update({
            where: { id: dep.id },
            data: {
              status: "ACTIVE",
              agentVersion: version.version,
              pauseReason: null,
            },
          });

          try {
            await queue.add("resume", { type: "resume", deploymentId: dep.id });
          } catch (err: any) {
            console.warn(`[vet-decision] Failed to enqueue resume for ${dep.id}:`, err.message);
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

      console.log(`[vet-decision] Auto-resumed ${pausedDeployments.length} deployment(s) for agent ${version.agentId}`);
    }
  }

  return jsonSuccess({ message: `Decision: ${decision}` });
}
