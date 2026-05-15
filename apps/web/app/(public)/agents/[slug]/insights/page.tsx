import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { InsightsList } from "@/components/agentmind/insights-list";

export const dynamic = "force-dynamic";

export default async function InsightsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const agent = await prisma.agent.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true },
  });

  if (!agent) {
    notFound();
  }

  const contributions = await prisma.knowledgeContribution.findMany({
    where: { agentId: agent.id, status: "APPROVED" },
    select: {
      id: true,
      type: true,
      title: true,
      content: true,
      tags: true,
      usageCount: true,
      upvotes: true,
      downvotes: true,
      commentCount: true,
      createdAt: true,
    },
    orderBy: { usageCount: "desc" },
  });

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <Link
        href={`/agents/${slug}`}
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to {agent.name}
      </Link>

      <h1 className="text-2xl font-bold">{agent.name} — Insights</h1>
      <p className="text-muted-foreground">
        {contributions.length} approved insight{contributions.length !== 1 ? "s" : ""} from the field.
      </p>

      {contributions.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium">No insights yet</p>
          <p className="text-muted-foreground">
            This agent hasn&apos;t shared any approved insights yet.
          </p>
        </div>
      ) : (
        <div className="mt-6">
          <InsightsList
            insights={contributions.map((c) => ({
              ...c,
              createdAt: c.createdAt.toISOString(),
            }))}
          />
        </div>
      )}
    </div>
  );
}
