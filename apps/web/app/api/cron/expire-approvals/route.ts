import { prisma } from "@/lib/db";
import { jsonSuccess, jsonError } from "@/lib/api-utils";

/**
 * Cron routes bypass Clerk by design (middleware's isInternalRoute), so the Bearer
 * check below is the only thing standing in front of them. Both of these ran for
 * anyone until 2026-08-04 — an unauthenticated POST from a shell returned 200 —
 * while the third cron route, creator-payouts, had checked all along. That
 * asymmetry is the whole bug: the pattern existed and these two just missed it.
 */
const CRON_SECRET = process.env.CRON_SECRET || "";

function unauthorized(request: Request): boolean {
  const auth = request.headers.get("authorization") || "";
  return !!CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`;
}

export async function POST(request: Request) {
  if (unauthorized(request)) return jsonError("Unauthorized", 401);
  const result = await prisma.approval.updateMany({
    where: {
      status: "PENDING",
      expiresAt: { lt: new Date() },
    },
    data: {
      status: "EXPIRED",
    },
  });

  return jsonSuccess({ expired: result.count });
}
