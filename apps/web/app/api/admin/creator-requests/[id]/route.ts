import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

/**
 * Admin: approve or deny a creator access request.
 *
 * POST { action: "approve" | "deny" }. Approve flips the creator to APPROVED so
 * they can publish; deny sets DENIED (they can resubmit, which returns them to
 * PENDING). reviewedAt records when the decision was made.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Gated like the platform's other operator actions (e.g. approving an agent to
  // go live): a logged-in operator on the /admin surface. See the admin-role
  // hardening note if this is ever tightened to real roles.
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== "approve" && action !== "deny") {
    return jsonError('action must be "approve" or "deny".', 400);
  }

  const creator = await prisma.creator.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!creator) return jsonError("Creator request not found.", 404);

  const updated = await prisma.creator.update({
    where: { id },
    data: {
      status: action === "approve" ? "APPROVED" : "DENIED",
      reviewedAt: new Date(),
    },
    select: { id: true, status: true, displayName: true, email: true },
  });

  return jsonSuccess({ creator: updated });
}
