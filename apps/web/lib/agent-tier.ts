import { prisma } from "@/lib/db";
import { orgOnlyScopes, requiresOrgTier, type GraphScope } from "@marketplace/agent-package-schema";

/**
 * Which tiers a version of an agent can be hired on.
 *
 * Read from the version's stored manifest — the one the reviewer approved —
 * like its outside sites, so the listing, the hire wizard and the hire itself
 * all answer from the same place.
 *
 *   requiresOrg  it cannot be hired on Email only
 *   orgScopes    what only the connected tier gives it: why it is connected-only,
 *                or, for an agent that works on both, what connecting adds
 *   declared     it declared graphScopes at all (agents published before the
 *                field existed did not)
 */
export type AgentTierRequirement = {
  requiresOrg: boolean;
  orgScopes: GraphScope[];
  declared: boolean;
};

export function tierOfManifest(manifest: unknown): AgentTierRequirement {
  return {
    requiresOrg: requiresOrgTier(manifest),
    orgScopes: orgOnlyScopes(manifest),
    declared: Array.isArray((manifest as { graphScopes?: unknown } | null)?.graphScopes),
  };
}

export async function tierOfVersion(
  agentId: string,
  version: string | null | undefined,
): Promise<AgentTierRequirement> {
  if (!version) return { requiresOrg: false, orgScopes: [], declared: false };
  const row = await prisma.agentVersion.findUnique({
    where: { agentId_version: { agentId, version } },
    select: { manifestData: true },
  });
  return tierOfManifest(row?.manifestData);
}
