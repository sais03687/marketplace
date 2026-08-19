import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/api-utils";
import type { Deployment } from "@prisma/client";
import { tokensMatch } from "@/lib/constant-time";

/**
 * Authenticate a call made *by* a deployment, rather than by a person.
 *
 * The AgentMind endpoints took a deploymentId in the request and checked only
 * that it existed and was ACTIVE. Nothing proved the caller was that deployment,
 * and an unauthenticated POST from outside the network reached the handler on
 * 2026-08-18. Contributions auto-approve by default and search serves them to
 * every deployment of an agent across every company, so that was a way to put
 * chosen text into other companies' agents.
 *
 * The token is the deployment's own `approvalWebhookToken`, which the adapter
 * and the poller already hold and which /approvals/auto-complete already used.
 * Comparing it here rather than in each route means the next endpoint the agent
 * calls cannot forget: there is one thing to call, and it returns the deployment
 * so nothing needs a second lookup.
 */
export type DeploymentAuth = { deployment: Deployment } | { error: Response };

export async function requireDeploymentToken(
  request: Request,
  deploymentId: string,
): Promise<DeploymentAuth> {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();

  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });

  // 404 before the token check, and the same 404 for a deployment that does not
  // exist: telling an unauthenticated caller which ids are real is a lookup
  // service for the thing this is defending.
  if (!deployment) return { error: jsonError("Deployment not found", 404) };

  if (!presented || !tokensMatch(presented, deployment.approvalWebhookToken)) {
    return { error: jsonError("Invalid or missing deployment token", 403) };
  }

  return { deployment };
}
