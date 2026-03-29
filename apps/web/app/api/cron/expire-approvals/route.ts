import { prisma } from "@/lib/db";
import { jsonSuccess } from "@/lib/api-utils";

export async function POST() {
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
