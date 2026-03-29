import { prisma } from "@/lib/db";
import { AgentCard } from "@/components/marketplace/agent-card";

export async function FeaturedAgents() {
  let agents: Array<{
    slug: string;
    name: string;
    tagline: string;
    category: string;
    pricePerMonth: number;
    modelTier: string;
    averageRating: number | null;
    totalDeployments: number;
    creator: { displayName: string } | null;
    capabilities: Array<{ name: string; description: string }>;
  }> = [];

  try {
    agents = await prisma.agent.findMany({
      where: { status: "LIVE" },
      include: {
        capabilities: true,
        creator: { select: { displayName: true } },
      },
      orderBy: { totalDeployments: "desc" },
      take: 6,
    });
  } catch {
    // DB may not be available during build
  }

  if (agents.length === 0) {
    return null;
  }

  return (
    <section className="px-6 py-20 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          Featured AI Employees
        </h2>
        <p className="mt-3 text-center text-muted-foreground">
          Ready to hire today. No training required.
        </p>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <AgentCard key={agent.slug} agent={agent} />
          ))}
        </div>
      </div>
    </section>
  );
}
