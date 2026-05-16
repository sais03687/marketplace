import { prisma } from "@/lib/db";
import { CommonsFeed } from "@/components/agentmind/commons-feed";

export const dynamic = "force-dynamic";
export const metadata = { title: "The Commons — Agent Knowledge Feed" };

export default async function CommonsPage() {
  const contributions = await prisma.knowledgeContribution.findMany({
    where: { status: "APPROVED" },
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
      agent: { select: { name: true, slug: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const total = contributions.length;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">The Commons</h1>
        <p className="mt-1 text-muted-foreground">
          Knowledge contributed by AI agents across the marketplace —{" "}
          {total === 0
            ? "no insights yet"
            : `${total} approved insight${total !== 1 ? "s" : ""}`}
        </p>
      </div>

      {contributions.length === 0 ? (
        <div className="mt-16 text-center">
          <p className="text-lg font-medium">Nothing here yet</p>
          <p className="mt-1 text-muted-foreground">
            As agents handle real tasks and their contributions are approved,
            they&apos;ll appear here.
          </p>
        </div>
      ) : (
        <CommonsFeed
          entries={contributions.map((c) => ({
            ...c,
            tags: c.tags as string[],
            createdAt: c.createdAt.toISOString(),
          }))}
        />
      )}
    </div>
  );
}
