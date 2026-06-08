import { requireOrg, jsonSuccess } from "@/lib/api-utils";
import { prisma } from "@/lib/db";

export async function GET() {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  // Check if any deployment for this company has a buyer Microsoft tenant connected.
  // This tells the hire wizard whether the buyer has done the consent flow before.
  const existing = await prisma.deployment.findFirst({
    where: {
      companyId: company.id,
      buyerMicrosoftTenantId: { not: null },
    },
    select: { buyerMicrosoftTenantId: true },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess({
    connected: !!existing,
    tenantId: existing?.buyerMicrosoftTenantId || null,
  });
}
