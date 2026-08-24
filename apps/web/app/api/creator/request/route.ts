import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

/**
 * Creator access requests.
 *
 * GET  — the signed-in user's own creator status: "none" (never requested),
 *        "PENDING", "APPROVED", or "DENIED". Drives the Creator page UI.
 * POST — submit or update a request. Creates a PENDING creator row carrying the
 *        person's name, contact email, and a note about themselves, so an admin
 *        can reach out and approve or deny. Publishing stays blocked until an
 *        admin approves (see packages/upload and agents/[slug]/versions).
 *
 * Reuses the Creator row rather than a separate table: a pending creator is just
 * a Creator with status PENDING and no agents yet.
 */
export async function GET() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
    select: { status: true, displayName: true, email: true, requestNote: true },
  });

  if (!creator) return jsonSuccess({ status: "none" });
  return jsonSuccess({
    status: creator.status,
    displayName: creator.displayName,
    email: creator.email,
    requestNote: creator.requestNote,
  });
}

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const body = await request.json().catch(() => null);
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const note = typeof body?.note === "string" ? body.note.trim() : "";

  if (!displayName || !email) {
    return jsonError("Name and a contact email are required.", 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonError("Please provide a valid email address.", 400);
  }

  const existing = await prisma.creator.findUnique({ where: { clerkUserId: userId } });

  // Already approved — nothing to request.
  if (existing?.status === "APPROVED") {
    return jsonSuccess({ status: "APPROVED", message: "You already have creator access." });
  }

  // A denied request can be resubmitted; it returns to PENDING for another look.
  if (existing) {
    const updated = await prisma.creator.update({
      where: { clerkUserId: userId },
      data: { displayName, email, requestNote: note || null, status: "PENDING", reviewedAt: null },
      select: { status: true },
    });
    return jsonSuccess({ status: updated.status, message: "Your request has been submitted." });
  }

  // Guard the unique email: another account may have used it.
  const emailTaken = await prisma.creator.findUnique({ where: { email } });
  if (emailTaken) {
    return jsonError("That email is already associated with another creator account.", 409);
  }

  const created = await prisma.creator.create({
    data: {
      clerkUserId: userId,
      displayName,
      email,
      requestNote: note || null,
      status: "PENDING",
    },
    select: { status: true },
  });
  return jsonSuccess({ status: created.status, message: "Your request has been submitted." });
}
