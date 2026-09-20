import { prisma } from "@/lib/db";
import { jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { requireDeploymentToken } from "@/lib/deployment-token";

/**
 * "The agent's email never arrived."
 *
 * Sending is two steps that look like one. Graph accepts the message and the
 * platform logs "Sent" — but delivery happens afterwards, and when it fails the
 * bounce comes back to the agent's own mailbox. The poller drops bounces on
 * purpose (a delivery failure handed to the agent reads as an ordinary email and
 * it drafts a reply to a mail daemon), so the failure ended there: no log a buyer
 * reads, no record, no sign. The agent just looked silent.
 *
 * That is the worst shape a failure can take on this product, because the thing
 * that went missing is usually the thing the buyer was waiting for — an approval
 * request, or the answer itself. So the bounce is recorded here and shown on the
 * agent's page until the buyer dismisses it.
 *
 * Posted by the poller with the deployment's own token, like the heartbeat.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authed = await requireDeploymentToken(request, id);
  if ("error" in authed) return authed.error;

  let to = "";
  let reason = "";
  try {
    const body = (await request.json()) as { to?: string; reason?: string };
    to = String(body?.to ?? "").trim().slice(0, 320);
    reason = String(body?.reason ?? "").trim().slice(0, 500);
  } catch {
    // Fall through: a bounce we could not parse is still a bounce, and losing it
    // for want of a recipient line would reinstate exactly the silence this
    // endpoint exists to end.
  }

  await prisma.deployment.update({
    where: { id },
    data: {
      lastDeliveryFailureAt: new Date(),
      lastDeliveryFailureTo: to || null,
      lastDeliveryFailureReason: reason || null,
    },
  });

  return jsonSuccess({ ok: true });
}

/**
 * Dismiss the warning.
 *
 * Deliberately the buyer's call and not the platform's. There is no signal that
 * honestly means "delivery works again" — Graph accepting the next message means
 * no more than it did the first time — so nothing else may clear this. The person
 * who can check their own inbox decides.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;

  const depResult = await requireDeploymentAccess(id, orgResult.company.id);
  if ("error" in depResult) return depResult.error;

  await prisma.deployment.update({
    where: { id },
    data: {
      lastDeliveryFailureAt: null,
      lastDeliveryFailureTo: null,
      lastDeliveryFailureReason: null,
    },
  });

  return jsonSuccess({ ok: true });
}
