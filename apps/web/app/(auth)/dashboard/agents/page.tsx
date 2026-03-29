import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AgentStatusCard } from "@/components/dashboard/agent-status-card";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const { orgId } = await auth();
  if (!orgId) redirect("/");

  const company = await prisma.company.findUnique({
    where: { clerkOrgId: orgId },
  });

  if (!company) redirect("/dashboard");

  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id },
    include: {
      agent: true,
      _count: { select: { approvals: { where: { status: "PENDING" } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1 className="text-2xl font-bold">All Agents</h1>
      <p className="text-muted-foreground">
        Manage all hired AI employees, including fired agents.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {deployments.map((d) => (
          <AgentStatusCard key={d.id} deployment={d} />
        ))}
      </div>
    </div>
  );
}
