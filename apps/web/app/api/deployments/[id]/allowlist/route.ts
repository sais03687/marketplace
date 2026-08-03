import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, parseBody, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { agentTokenMatches } from "@/lib/agent-token";

const allowlistSchema = z.object({
  allowedEmails: z.array(z.string()).max(200),
});

/**
 * GET — the mail pollers read this to decide which senders may reach an agent.
 *
 * This was public, on the reasoning that the deployment id is itself a secret.
 * It is not: ids appear in dashboard URLs, in logs, and in anything that lists
 * deployments, and every creator knows their own. Anyone holding one could read
 * another company's allowlist, domain, and manager's email address — which is
 * personal data belonging to a third party. Confirmed against production on
 * 2026-08-01 with no session at all.
 *
 * Callers are either the platform (the provisioning service and the pollers,
 * which already hold PROVISIONING_SECRET) or a signed-in member of the owning
 * org. Nothing else has a reason to read it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = process.env.PROVISIONING_SECRET ?? "";
  // Three kinds of caller. The provisioning service and pollers hold the platform
  // secret. An agent container holds only its own derived token — it needs this
  // list because the platform now filters the agent's own mailbox reads against
  // it, which is what stops a blocked sender being read directly via inbox_list.
  const isPlatformCaller =
    (!!secret && presented === secret) || agentTokenMatches(presented, id, secret);

  if (!isPlatformCaller) {
    const orgResult = await requireOrg();
    if ("error" in orgResult) return orgResult.error;
    const access = await requireDeploymentAccess(id, orgResult.company.id);
    // Same shape as every other deployment route: absent and not-yours are
    // indistinguishable, so this cannot be used to test whether an id exists.
    if ("error" in access) return access.error;
  }

  const deployment = await prisma.deployment.findUnique({
    where: { id },
    select: {
      allowedEmails: true,
      managerEmail: true,
      company: { select: { domain: true } },
    },
  });

  if (!deployment) return jsonError("Not found", 404);

  return jsonSuccess({
    allowedEmails: (deployment.allowedEmails as string[]) ?? [],
    companyDomain: deployment.company.domain,
    managerEmail: deployment.managerEmail ?? null,
  });
}

/**
 * PATCH — requires org auth.
 * Body: { allowedEmails: string[] }
 * Entries can be full emails ("alice@acme.com") or domain wildcards ("@acme.com").
 * An empty array means "allow everyone" (no restriction).
 */
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

  const parsed = await parseBody(request, allowlistSchema);
  if ("error" in parsed) return parsed.error;

  // Normalize: lowercase, trim, dedupe
  const normalized = [
    ...new Set(parsed.data.allowedEmails.map((e) => e.toLowerCase().trim()).filter(Boolean)),
  ];

  await prisma.deployment.update({
    where: { id },
    data: { allowedEmails: normalized },
  });

  return jsonSuccess({ allowedEmails: normalized });
}
