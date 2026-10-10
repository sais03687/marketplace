import { prisma } from "@/lib/db";
import { declaredHosts } from "@marketplace/agent-package-schema";

/**
 * The outside sites a version of an agent declared (manifest `connectsTo`).
 *
 * Read from the version's stored manifest — the one the reviewer approved —
 * rather than from anything the listing could drift from. An unreadable or
 * invalid list counts as none, because nothing that failed the rules was ever
 * admitted by the agent's network gate either.
 */
export async function hostsOfVersion(agentId: string, version: string | null | undefined): Promise<string[]> {
  if (!version) return [];
  const row = await prisma.agentVersion.findUnique({
    where: { agentId_version: { agentId, version } },
    select: { manifestData: true },
  });
  return declaredHosts(row?.manifestData);
}

/** True when `accepted` names every host in `required` (order and case aside). */
export function acceptsAll(required: string[], accepted: unknown): boolean {
  if (required.length === 0) return true;
  if (!Array.isArray(accepted)) return false;
  const given = new Set(accepted.map((h) => String(h).trim().toLowerCase()));
  return required.every((h) => given.has(h));
}
