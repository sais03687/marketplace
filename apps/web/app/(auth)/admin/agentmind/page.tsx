import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TYPE_COLORS: Record<string, string> = {
  CORRECTION: "bg-blue-50 text-blue-700 border-blue-200",
  PATTERN: "bg-emerald-50 text-emerald-700 border-emerald-200",
  RESPONSE_TEMPLATE: "bg-violet-50 text-violet-700 border-violet-200",
  TASK_RECIPE: "bg-amber-50 text-amber-700 border-amber-200",
};

export default async function AgentMindQueuePage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  // In production, check admin role via Clerk metadata
  const contributions = await prisma.knowledgeContribution.findMany({
    where: { status: "PENDING" },
    include: {
      agent: { select: { name: true, slug: true } },
      deployment: { select: { agentName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // Approved lessons the platform thinks are worth a second look. None of these
  // are wrong by definition — they are the shapes that went wrong before, and
  // the point is that somebody sees them rather than the corpus quietly rotting:
  //   past due          a CORRECTION outlives the failure it describes
  //   suppressing work  injected repeatedly, and the agent then did nothing
  //   flagged           held at contribute time as a cluster or unfounded
  const now = new Date();
  const needsAttention = await prisma.knowledgeContribution.findMany({
    where: {
      status: "APPROVED",
      OR: [
        { reviewDueAt: { lt: now } },
        { flagReason: { not: null } },
        { AND: [{ injectedCount: { gte: 3 } }, { noActionCount: { gte: 2 } }] },
      ],
    },
    include: {
      agent: { select: { name: true, slug: true } },
      deployment: { select: { agentName: true } },
    },
    orderBy: { noActionCount: "desc" },
    take: 50,
  });

  const attentionReason = (c: (typeof needsAttention)[number]): string => {
    if (c.injectedCount >= 3 && c.noActionCount / c.injectedCount >= 0.5) {
      return `injected ${c.injectedCount}×, no action ${c.noActionCount}× — may be suppressing work`;
    }
    if (c.flagReason === "cluster") return "near-duplicate of other lessons";
    if (c.flagReason === "unfounded") return "written by a run that took no action";
    if (c.reviewDueAt && c.reviewDueAt < now) {
      return `review due ${formatDate(c.reviewDueAt)}`;
    }
    return "flagged";
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold">Admin: AgentMind Review Queue</h1>
      <p className="text-muted-foreground">
        Review and approve knowledge contributions from agents.
      </p>

      {needsAttention.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold">Needs attention</h2>
          <p className="text-sm text-muted-foreground">
            Already approved, but showing a pattern worth checking. Nothing here is
            removed automatically.
          </p>
          <div className="mt-3 space-y-2">
            {needsAttention.map((c: (typeof needsAttention)[number]) => (
              <Card key={c.id} className="border-amber-200">
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{c.title}</span>
                      <Badge variant="outline" className={TYPE_COLORS[c.type] ?? ""}>
                        {c.type}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-amber-700">{attentionReason(c)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.agent.name} · used {c.usageCount}× · added {formatDate(c.createdAt)}
                    </p>
                  </div>
                  {/* Informational only. Acting on these goes through the same
                      PATCH/DELETE handlers the buyer's knowledge table uses; a
                      button here would need a client component, and a control
                      that looks live but does nothing is worse than none. */}
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {c.id.slice(0, 8)}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <h2 className="mt-8 text-lg font-semibold">Pending review</h2>
      {contributions.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium">No contributions to review</p>
          <p className="text-muted-foreground">
            All knowledge contributions have been reviewed.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {contributions.map((c: typeof contributions[number]) => (
            <Card key={c.id}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{c.title}</h3>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${TYPE_COLORS[c.type] || ""}`}
                      >
                        {c.type.replace(/_/g, " ")}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.agent.name} &middot; {c.deployment.agentName}
                    </p>

                    {/* Sanitization log summary */}
                    {Array.isArray(c.sanitizationLog) && (
                      <div className="mt-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          Guardrail log:
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(c.sanitizationLog as Array<{ stage: string; action: string }>).map(
                            (entry, i) => (
                              <Badge
                                key={i}
                                variant={
                                  entry.action === "redacted"
                                    ? "destructive"
                                    : "secondary"
                                }
                                className="text-[10px]"
                              >
                                {entry.stage}: {entry.action}
                              </Badge>
                            ),
                          )}
                        </div>
                      </div>
                    )}

                    {/* Content preview */}
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-medium text-primary">
                        View Content
                      </summary>
                      <div className="mt-2 rounded-lg border bg-muted/30 p-3">
                        <p className="whitespace-pre-wrap text-sm">
                          {c.content}
                        </p>
                      </div>
                    </details>

                    {c.tags.length > 0 && (
                      <div className="mt-2 flex gap-1">
                        {c.tags.map((tag: string) => (
                          <Badge key={tag} variant="outline" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <div>
                    <label
                      htmlFor={`note-${c.id}`}
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Review note (optional)
                    </label>
                    <Input
                      id={`note-${c.id}`}
                      name="note-input"
                      placeholder="Add a note about your decision..."
                      className="mt-1"
                      data-note-for={c.id}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Submitted {formatDate(c.createdAt)}
                    </span>
                    <div className="flex gap-2">
                      <form
                        action={`/api/admin/agentmind/${c.id}/review`}
                        method="POST"
                      >
                        <input
                          type="hidden"
                          name="decision"
                          value="APPROVED"
                        />
                        <Button size="sm">Approve</Button>
                      </form>
                      <form
                        action={`/api/admin/agentmind/${c.id}/review`}
                        method="POST"
                      >
                        <input
                          type="hidden"
                          name="decision"
                          value="REJECTED"
                        />
                        <Button size="sm" variant="destructive">
                          Reject
                        </Button>
                      </form>
                    </div>
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
