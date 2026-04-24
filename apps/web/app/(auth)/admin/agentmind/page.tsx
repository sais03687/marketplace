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

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold">Admin: AgentMind Review Queue</h1>
      <p className="text-muted-foreground">
        Review and approve knowledge contributions from agents.
      </p>

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
