import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { resolveModel } from "@/lib/model-resolver";
import { hostsOfVersion } from "@/lib/connects-to";
import { addedHosts } from "@marketplace/agent-package-schema";
import { jsonError, jsonSuccess, requireAdmin } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { sendPlatformEmail, buildVettingDecisionEmail } from "@/lib/email";
import { getProvisioningQueue } from "@/lib/provisioning-queue";


export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Approving/rejecting an agent version to go live is an admin action.
  const authResult = await requireAdmin();
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
  // Not gated on any env var. It used to be gated on PLATFORM_NOTIFICATION_INBOX_ID,
  // an AgentMail inbox id that is set nowhere and referenced only here, so this
  // whole block was skipped on every decision — silently, since the skip was the
  // `if` itself and never reached the logging inside. Creators were approved and
  // rejected without ever being told.
  {
    const { subject, html } = buildVettingDecisionEmail({
      agentName: version.agent.name,
      version: version.version,
      decision: decision as "MANUALLY_APPROVED" | "FAILED" | "PASSED",
      feedback: feedback || undefined,
    });
    // Awaited despite costing a little latency: not blocking the response means
    // the send is cancelled with the function on Vercel, and a creator who is
    // never told their package was rejected is worse than a slower request.
    try {
      await sendPlatformEmail({ to: version.agent.creator.email, subject, html });
    } catch (err: any) {
      // The decision itself stands — it is already written. Losing the email is
      // bad but recoverable by hand, whereas failing the request would leave the
      // admin unsure whether the decision took effect.
      console.error(
        `[vet-decision] Could not tell ${version.agent.creator.email} that ` +
          `${version.agent.name} v${version.version} was ${decision}: ${err.message}`,
      );
    }
  }

  // ── If approved: update agent + trigger auto-updates ──────────────────────
  if (decision === "MANUALLY_APPROVED") {
    const updateData: Record<string, unknown> = {
      status: "LIVE",
      currentVersion: version.version,
    };

    // The listing follows the approved version. Uploading a version used to
    // change only some of this (and before review); approval updated just the
    // capabilities, so a new version's description never reached the page.
    if (version.manifestData) {
      const m = version.manifestData as Record<string, unknown>;
      for (const field of ["name", "tagline", "description", "category"] as const) {
        if (typeof m[field] === "string" && (m[field] as string).trim()) updateData[field] = m[field];
      }
      if ("graphScopes" in m) updateData.graphScopes = m.graphScopes ?? Prisma.DbNull;
      let model = typeof m._resolvedModel === "string" ? (m._resolvedModel as string) : null;
      let tier = typeof m._modelTier === "string" ? (m._modelTier as string) : null;
      if (!model && typeof m.model === "string" && m.model.trim()) {
        const resolved = await resolveModel(m.model.trim());
        if (!("error" in resolved)) {
          model = m.model.trim();
          tier = resolved.model.tier.toUpperCase();
        }
      }
      if (model) updateData.model = model;
      if (tier) updateData.modelTier = tier;
    }

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

    // ── Auto-update deployments with autoUpdate: true ────────────────────────
    //
    // ONBOARDING counts as well as ACTIVE. The setting says "apply new versions
    // from the creator as they are approved" with no caveat, and the update job
    // has always accepted both states — only this query was narrower, so a hire
    // still being set up silently kept the version it was provisioned with and
    // nothing said the setting had not applied to it. A hire mid-setup is if
    // anything the one that most wants the newest package.
    const autoUpdateDeployments = await prisma.deployment.findMany({
      where: {
        agentId: version.agentId,
        status: { in: ["ACTIVE", "ONBOARDING"] },
        autoUpdate: true,
        agentVersion: { not: version.version },
      },
    });

    // A version that reaches outside sites a hire's current version did not is
    // never applied automatically: auto-update is consent to the creator's
    // improvements, not to new places the agent can send the buyer's data.
    // Those hires keep their version, and their dashboard asks the buyer.
    const hostsAfter = await hostsOfVersion(version.agentId, version.version);
    if (autoUpdateDeployments.length > 0) {
      await Promise.all(
        autoUpdateDeployments.map(async (dep) => {
          const added = addedHosts(await hostsOfVersion(version.agentId, dep.agentVersion), hostsAfter);
          if (added.length > 0) {
            console.log(
              `[vet-decision] Not auto-updating ${dep.id}: v${version.version} adds outside sites ` +
                `(${added.join(", ")}) the buyer has not accepted`,
            );
            return;
          }
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
