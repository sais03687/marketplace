import { prisma } from "@marketplace/db";
import { provisionJob } from "./provision.js";

export class ActivationError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Start a prepared hire. Called when the buyer clicks Activate.
 *
 * A new hire is prepared at payment — mailbox, licence and image ready — and
 * nothing of the agent runs until this: no container, no mail poller, no
 * onboarding brief. That was the buyer's ask: an agent they have not activated
 * should not be reading their mail or acting on it, and on 2026-10-11 a newly
 * hired agent answered two emails before its owner had clicked Activate.
 *
 * Resolves once the agent is running and healthy, so the caller sends the
 * introduction only to an agent that can answer the reply. If starting fails,
 * the hire goes back to ready-to-activate rather than ERROR — the mailbox and
 * image are still good, and the buyer can simply try again.
 */
export async function activateDeployment(deploymentId: string): Promise<{ alreadyRunning: boolean }> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { status: true, containerName: true },
  });
  if (!deployment) throw new ActivationError(404, "Deployment not found");
  if (deployment.status === "PROVISIONING") {
    throw new ActivationError(409, "This agent is already starting");
  }
  if (deployment.status !== "ONBOARDING") {
    throw new ActivationError(409, `This agent can't be activated from ${deployment.status}`);
  }
  // Hired before this existed: started at provisioning, so there is nothing to start.
  if (deployment.containerName) return { alreadyRunning: true };

  // Claimed in one statement, so a second click cannot start a second copy.
  const claimed = await prisma.deployment.updateMany({
    where: { id: deploymentId, status: "ONBOARDING", containerName: null },
    data: { status: "PROVISIONING" },
  });
  if (claimed.count === 0) throw new ActivationError(409, "This agent is already starting");

  try {
    await provisionJob(deploymentId, "ONBOARDING", { start: true, reuseImage: true });
  } catch (err: any) {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "ONBOARDING", containerName: null },
    });
    throw new ActivationError(502, `The agent could not be started: ${err?.message ?? err}`);
  }
  return { alreadyRunning: false };
}
