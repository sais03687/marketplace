import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OnboardingPanel } from "@/components/dashboard/onboarding-panel";

import { Pause, Play, UserX } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = await params;
  const { orgId } = await auth();
  if (!orgId) redirect("/");

  const company = await prisma.company.findUnique({
    where: { clerkOrgId: orgId },
  });
  if (!company) redirect("/dashboard");

  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, companyId: company.id },
    include: {
      agent: true,
      _count: {
        select: {
          approvals: true,
        },
      },
    },
  });

  if (!deployment) notFound();

  const thisWeekApprovals = await prisma.approval.count({
    where: {
      deploymentId,
      createdAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    },
  });

  const approvedCount = await prisma.approval.count({
    where: { deploymentId, status: "APPROVED" },
  });
  const totalResolved = await prisma.approval.count({
    where: {
      deploymentId,
      status: { in: ["APPROVED", "EDITED", "REJECTED"] },
    },
  });
  const approvalRate = totalResolved > 0 ? approvedCount / totalResolved : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{deployment.agentName}</h1>
          <p className="text-muted-foreground">{deployment.agent.name}</p>
        </div>
        <Badge
          className={
            deployment.status === "ACTIVE"
              ? "bg-emerald-100 text-emerald-800"
              : deployment.status === "ONBOARDING"
                ? "bg-blue-100 text-blue-800"
                : deployment.status === "PAUSED"
                  ? "bg-gray-100 text-gray-800"
                  : "bg-amber-100 text-amber-800"
          }
        >
          {deployment.status}
        </Badge>
      </div>

      {deployment.status === "ONBOARDING" && (
        <OnboardingPanel deploymentId={deploymentId} />
      )}

      {deployment.status !== "ONBOARDING" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Tasks This Week</p>
              <p className="text-2xl font-bold">{thisWeekApprovals}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Approval Rate</p>
              <p className="text-2xl font-bold">
                {Math.round(approvalRate * 100)}%
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Total Actions</p>
              <p className="text-2xl font-bold">{deployment._count.approvals}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {deployment.status !== "FIRED" && deployment.status !== "ONBOARDING" && (
        <div className="flex gap-2">
          <form action={`/api/deployments/${deploymentId}/pause`} method="POST">
            <Button variant="outline" type="submit">
              {deployment.status === "PAUSED" ? (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Resume
                </>
              ) : (
                <>
                  <Pause className="mr-2 h-4 w-4" />
                  Pause
                </>
              )}
            </Button>
          </form>
          <form action={`/api/deployments/${deploymentId}/fire`} method="POST">
            <Button variant="destructive" type="submit">
              <UserX className="mr-2 h-4 w-4" />
              Fire
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
