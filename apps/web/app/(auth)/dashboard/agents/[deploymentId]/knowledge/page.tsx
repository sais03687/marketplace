import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { DeleteContributionButton } from "./delete-button";
import { MuteContributionButton } from "./mute-button";

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

  // Lessons this agent can draw on that were written by somebody else.
  //
  // AgentMind is a commons scoped to the agent type, not to a company, so these
  // arrive from other buyers' deployments. They cannot be deleted here — they are
  // not this company's to remove — but they can be silenced for this agent, which
  // until now was impossible: the only lever was turning AgentMind off entirely.
  const commonsLessons = await prisma.knowledgeContribution.findMany({
    where: {
      agentId: deployment.agentId,
      status: "APPROVED",
      deploymentId: { not: deploymentId },
    },
    select: {
      id: true, title: true, type: true, usageCount: true,
      injectedCount: true, noActionCount: true,
      mutes: { where: { deploymentId }, select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

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

      {commonsLessons.length > 0 && (
        <div className="mt-10">
          <h2 className="text-xl font-semibold">Shared lessons your agent can use</h2>
          <p className="text-sm text-muted-foreground">
            AgentMind is shared between every company running this agent, so these
            were written by someone else&apos;s {deployment.agentName} and can be
            pulled into yours when a task looks similar.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Muting</span> stops a
            lesson being given to {deployment.agentName} — it will no longer show up
            when your agent looks for relevant knowledge, and cannot influence how it
            answers. Nothing is deleted: the lesson stays for the company that wrote
            it and for everyone else, and you can unmute at any time. Use it when a
            lesson is wrong for how your organisation works, or when the note below
            suggests it is stopping your agent doing its job.
          </p>
          <div className="mt-4 space-y-2">
            {commonsLessons.map((c) => {
              const muted = c.mutes.length > 0;
              const suppressing =
                c.injectedCount >= 3 && c.noActionCount / c.injectedCount >= 0.5;
              return (
                <Card key={c.id} className={muted ? "opacity-60" : undefined}>
                  <CardContent className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{c.title}</span>
                        <Badge variant="outline" className="text-[10px]">{c.type}</Badge>
                        {muted && <Badge variant="outline" className="text-[10px]">Muted</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Used {c.usageCount}x
                        {suppressing && (
                          <span className="ml-2 text-amber-700">
                            · your agent took no action {c.noActionCount} of the last{" "}
                            {c.injectedCount} times this was used
                          </span>
                        )}
                      </p>
                    </div>
                    <MuteContributionButton
                      deploymentId={deploymentId}
                      contributionId={c.id}
                      muted={muted}
                    />
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
