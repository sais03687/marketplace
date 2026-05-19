import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AgentStatusCard } from "@/components/dashboard/agent-status-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Bot, Plus } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { orgId } = await auth();
  if (!orgId) redirect("/");

  const company = await prisma.company.findUnique({
    where: { clerkOrgId: orgId },
  });

  if (!company) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Bot className="h-12 w-12 text-muted-foreground" />
        <h2 className="mt-4 text-xl font-semibold">Hire your first AI employee</h2>
        <p className="mt-2 text-muted-foreground">
          Browse our marketplace to find the right hire for your team.
        </p>
        <Button className="mt-6" asChild>
          <Link href="/browse">Browse Agents</Link>
        </Button>
      </div>
    );
  }

  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id, status: { not: "FIRED" } },
    include: {
      agent: true,
      _count: {
        select: { approvals: { where: { status: "PENDING" } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Check for old pending approvals
  const oldApprovals = await prisma.approval.count({
    where: {
      deployment: { companyId: company.id },
      status: "PENDING",
      createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });

  const deploymentsWithUpdate = deployments.map((d) => ({
    ...d,
    updateAvailable:
      d.agent.currentVersion !== null &&
      d.agentVersion !== d.agent.currentVersion,
  }));

  const totalPending = deploymentsWithUpdate.reduce(
    (sum, d) => sum + (d._count?.approvals ?? 0),
    0,
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground">Your AI employees at a glance.</p>
        </div>
        <Button asChild>
          <Link href="/browse">
            <Plus className="mr-2 h-4 w-4" />
            Hire Agent
          </Link>
        </Button>
      </div>

      {oldApprovals > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p>
            You have {oldApprovals} approval{oldApprovals > 1 ? "s" : ""} waiting
            more than 24 hours.{" "}
            <Link
              href="/dashboard/approvals"
              className="font-medium underline"
            >
              Review now
            </Link>
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Active Agents</p>
            <p className="text-2xl font-bold">
              {deploymentsWithUpdate.filter((d) => d.status === "ACTIVE").length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Pending Approvals</p>
            <p className="text-2xl font-bold">{totalPending}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Total Hired</p>
            <p className="text-2xl font-bold">{deploymentsWithUpdate.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Agent Cards */}
      {deploymentsWithUpdate.length === 0 ? (
        <div className="mt-12 flex flex-col items-center justify-center py-12 text-center">
          <Bot className="h-12 w-12 text-muted-foreground" />
          <h2 className="mt-4 text-xl font-semibold">
            Hire your first AI employee
          </h2>
          <p className="mt-2 text-muted-foreground">
            Browse our marketplace to find the right hire for your team.
          </p>
          <Button className="mt-6" asChild>
            <Link href="/browse">Browse Agents</Link>
          </Button>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {deploymentsWithUpdate.map((d) => (
            <AgentStatusCard key={d.id} deployment={d} updateAvailable={d.updateAvailable} />
          ))}
        </div>
      )}
    </div>
  );
}
