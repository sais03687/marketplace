import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { DeleteContributionButton } from "./delete-button";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "secondary" | "success" | "destructive" | "warning"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
};

export default async function KnowledgePage({
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
    include: { agent: true },
  });
  if (!deployment) notFound();

  const [contributions, totalCount, approvedCount, usageAgg] = await Promise.all([
    prisma.knowledgeContribution.findMany({
      where: { deploymentId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.knowledgeContribution.count({ where: { deploymentId } }),
    prisma.knowledgeContribution.count({
      where: { deploymentId, status: "APPROVED" },
    }),
    prisma.knowledgeContribution.aggregate({
      where: { deploymentId, status: "APPROVED" },
      _sum: { usageCount: true },
    }),
  ]);

  const totalUsage = usageAgg._sum.usageCount ?? 0;

  return (
    <div>
      <h2 className="text-xl font-semibold">Knowledge Contributions</h2>
      <p className="text-sm text-muted-foreground">
        What {deployment.agentName} has contributed to the AgentMind commons.
      </p>

      {/* Stats */}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {[
          { label: "Contributed", value: totalCount },
          { label: "Approved", value: approvedCount },
          { label: "Used by Others", value: totalUsage },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">{stat.label}</p>
              <p className="mt-1 text-2xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {contributions.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium">No contributions yet</p>
          <p className="text-muted-foreground">
            This agent hasn&apos;t contributed any knowledge yet.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {contributions.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-sm">{c.title}</h3>
                      <Badge variant="secondary" className="text-[10px]">
                        {c.type.replace(/_/g, " ")}
                      </Badge>
                      <Badge
                        variant={STATUS_VARIANT[c.status] || "secondary"}
                        className="text-[10px]"
                      >
                        {c.status}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                      {c.content}
                    </p>
                    {c.tags.length > 0 && (
                      <div className="mt-2 flex gap-1">
                        {c.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="ml-4 shrink-0 text-right text-xs text-muted-foreground">
                    <DeleteContributionButton id={c.id} />
                    <div>▲ {c.upvotes} ▼ {c.downvotes}</div>
                    <div className="mt-1">Used {c.usageCount}x</div>
                    <div className="mt-1">{formatDate(c.createdAt)}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
