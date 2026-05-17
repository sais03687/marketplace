import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, parseBody, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

const allowlistSchema = z.object({
  allowedEmails: z.array(z.string()).max(200),
});

/**
 * GET — public (deployment ID is effectively a secret cuid).
 * Used by the agentmail poller to fetch the allowlist at startup.
 * Returns the allowlist plus the company domain so the poller can
 * always permit intra-company emails without explicit listing.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const deployment = await prisma.deployment.findUnique({
    where: { id },
    select: {
      allowedEmails: true,
      weeklyDigestEmail: true,
      company: { select: { domain: true } },
    },
  });

  if (!deployment) return jsonError("Not found", 404);

  return jsonSuccess({
    allowedEmails: (deployment.allowedEmails as string[]) ?? [],
    companyDomain: deployment.company.domain,
    managerEmail: deployment.weeklyDigestEmail ?? null,
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
