import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { jsonSuccess, jsonError, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { requireDeploymentToken } from "@/lib/deployment-token";

/**
 * The buyer reads their agent's memory here; the agent writes it here.
 *
 * This used to proxy to the provisioning service, which Vercel cannot reach —
 * the container sits behind a firewall Vercel is outside of — so it returned
 * "Container unreachable" on every request and the Memory tab was hidden.
 *
 * It now mirrors how approvals reach the dashboard: the agent pushes a snapshot
 * of its memory to the platform (POST, authenticated with its deployment token),
 * the snapshot is stored on the Deployment, and the buyer reads that stored copy
 * (GET, scoped to their own org). No container call, no firewall change.
 *
 * PRIVATE.md never travels this path — the agent assembles only MEMORY.md and
 * memory/*.md at source. The buyer only ever sees their own deployment's copy.
 */

// The buyer's read.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;

  const row = await prisma.deployment.findUnique({
    where: { id },
    select: { memorySnapshot: true, memorySyncedAt: true },
  });

  if (!row?.memorySnapshot) {
    // Not an error — a freshly hired agent has not pushed yet. The page shows a
    // "nothing recorded yet" state rather than a failure.
    return jsonSuccess({ memory: null, syncedAt: null });
  }

  return jsonSuccess({ memory: row.memorySnapshot, syncedAt: row.memorySyncedAt });
}

// The agent's write.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // The deployment's own token — the same credential approvals and AgentMind
  // already use. A person's session is not accepted here; only the agent writes.
  const authed = await requireDeploymentToken(request, id);
  if ("error" in authed) return authed.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const memory = (body as { memory?: unknown })?.memory;
  if (memory === undefined || memory === null || typeof memory !== "object") {
    return jsonError("memory object required", 400);
  }

  // Guard the invariant even though the agent already excludes it: a snapshot
  // must never carry PRIVATE.md. If one somehow arrives, drop it rather than
  // store it, and never fail the whole push over it.
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(memory as Record<string, unknown>)) {
    const base = key.split("/").pop() ?? key;
    if (base === "PRIVATE.md") continue;
    clean[key] = value;
  }

  await prisma.deployment.update({
    where: { id },
    data: { memorySnapshot: clean as Prisma.InputJsonValue, memorySyncedAt: new Date() },
  });

  return jsonSuccess({ ok: true, keys: Object.keys(clean).length });
}
