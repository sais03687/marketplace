import { prisma } from "@/lib/db";
import { jsonSuccess, jsonError } from "@/lib/api-utils";
import { requireDeploymentToken } from "@/lib/deployment-token";

/**
 * The agent's liveness signal.
 *
 * The agent posts here on a short timer with its self-reported health. The
 * dashboard reads `lastHeartbeatAt` to show Online / Not responding, and a
 * periodic check alerts the manager when it goes stale. This is how a silent
 * failure — a dead container, a stalled poller, a hung run — becomes visible,
 * instead of the buyer discovering it through days of nothing happening.
 *
 * Authenticated with the deployment's own token, like every other agent → platform
 * call. A person's session cannot forge a heartbeat.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authed = await requireDeploymentToken(request, id);
  if ("error" in authed) return authed.error;

  let ok = true;
  try {
    const body = (await request.json()) as { ok?: boolean };
    if (typeof body?.ok === "boolean") ok = body.ok;
  } catch {
    // A heartbeat with no body still counts as "the agent is alive enough to
    // post" — the timestamp is the signal that matters most.
  }

  await prisma.deployment.update({
    where: { id },
    data: {
      lastHeartbeatAt: new Date(),
      lastHeartbeatOk: ok,
      // A fresh heartbeat clears any prior alert, so recovery re-arms the
      // alarm rather than leaving it permanently fired.
      heartbeatAlertedAt: null,
    },
  });

  return jsonSuccess({ ok: true });
}
