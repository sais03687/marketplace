import { prisma } from "@/lib/db";
import { jsonSuccess, requireAdmin } from "@/lib/api-utils";

/**
 * Admin: list creator access requests to review.
 *
 * Returns pending requests first (the queue to act on), then recently reviewed
 * ones for reference. Includes each requester's contact email and note so the
 * admin can reach out before deciding.
 */
export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const creators = await prisma.creator.findMany({
    where: { status: { in: ["PENDING", "DENIED"] } },
    select: {
      id: true,
      displayName: true,
      email: true,
      requestNote: true,
      status: true,
      createdAt: true,
      reviewedAt: true,
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  return jsonSuccess({ requests: creators });
}
