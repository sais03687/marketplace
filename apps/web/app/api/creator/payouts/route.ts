import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

export async function GET() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) return jsonError("Creator not found", 404);

  const payouts = await prisma.payout.findMany({
    where: { creatorId: creator.id },
    orderBy: { periodStart: "desc" },
    take: 24, // last 2 years
  });

  const totalPaidCents = payouts
    .filter((p) => p.status === "PAID")
    .reduce((sum, p) => sum + p.creatorShareCents, 0);

  return jsonSuccess({
    payouts,
    totalPaidCents,
    totalPaidDollars: (totalPaidCents / 100).toFixed(2),
  });
}
