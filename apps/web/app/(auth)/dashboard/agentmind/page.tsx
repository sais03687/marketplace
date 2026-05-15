import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { ContributionsTable } from "@/components/agentmind/contributions-table";

export const dynamic = "force-dynamic";

export default async function AgentMindPage() {
  const { orgId } = await auth();
  if (!orgId) redirect("/");

  const company = await prisma.company.findUnique({
    where: { clerkOrgId: orgId },
  });
  if (!company) redirect("/dashboard");

  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id },
    select: { id: true, agentName: true },
  });
  const deploymentIds = deployments.map((d) => d.id);

  const [contributions, total, approved, pending, usageAgg] = await Promise.all([
    prisma.knowledgeContribution.findMany({
      where: { deploymentId: { in: deploymentIds } },
      include: {
        deployment: { select: { agentName: true } },
        agent: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds } },
    }),
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds }, status: "APPROVED" },
    }),
    prisma.knowledgeContribution.count({
      where: { deploymentId: { in: deploymentIds }, status: "PENDING" },
    }),
    prisma.knowledgeContribution.aggregate({
      where: { deploymentId: { in: deploymentIds }, status: "APPROVED" },
      _sum: { usageCount: true },
    }),
  ]);

  const totalUsage = usageAgg._sum.usageCount ?? 0;

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold">AgentMind</h1>
        <p className="text-muted-foreground">
          Your agents automatically contribute knowledge as they work. Review
          what they&apos;re sharing with the commons before it goes public.
        </p>
        {pending > 0 && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span className="font-semibold">{pending} contribution{pending !== 1 ? "s" : ""} waiting for your review</span>
            <span className="text-amber-600">— expand a row below to approve or reject.</span>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {[
          { label: "Total Contributions", value: total },
          { label: "Approved", value: approved },
          { label: "Pending Review", value: pending },
          { label: "Times Used by Others", value: totalUsage },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">{stat.label}</p>
              <p className="mt-1 text-2xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Contributions Table (expandable rows, filterable) */}
      {contributions.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium">No contributions yet</p>
          <p className="text-muted-foreground">
            Once your agents start working, they&apos;ll automatically share
            learnings here.
          </p>
        </div>
      ) : (
        <ContributionsTable
          contributions={contributions.map((c) => ({
            ...c,
            createdAt: c.createdAt.toISOString(),
          }))}
        />
      )}
    </div>
  );
}
