import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus } from "lucide-react";
import Link from "next/link";
import { formatPrice } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CreatorDashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
    include: {
      agents: {
        include: {
          _count: {
            select: { deployments: true },
          },
        },
      },
    },
  });

  if (!creator) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <h2 className="text-xl font-semibold">Welcome, Creator</h2>
        <p className="mt-2 text-muted-foreground">
          Publish your first AI agent to the marketplace.
        </p>
        <Button className="mt-6" asChild>
          <Link href="/creator/publish">
            <Plus className="mr-2 h-4 w-4" />
            Publish New Agent
          </Link>
        </Button>
      </div>
    );
  }

  const totalDeployments = creator.agents.reduce(
    (sum, a) => sum + a._count.deployments,
    0,
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Creator Dashboard</h1>
          <p className="text-muted-foreground">
            Welcome back, {creator.displayName}
          </p>
        </div>
        <Button asChild>
          <Link href="/creator/publish">
            <Plus className="mr-2 h-4 w-4" />
            Publish New Agent
          </Link>
        </Button>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Published Agents</p>
            <p className="text-2xl font-bold">{creator.agents.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Active Deployments</p>
            <p className="text-2xl font-bold">{totalDeployments}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Earnings</p>
            <p className="text-2xl font-bold">$0</p>
            <p className="text-xs text-muted-foreground">Billing not yet active</p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-4">Your Agents</h2>
        {creator.agents.length === 0 ? (
          <p className="text-muted-foreground">No agents published yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {creator.agents.map((agent) => (
              <Card key={agent.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between">
                    <h3 className="font-semibold">{agent.name}</h3>
                    <Badge
                      variant={agent.status === "LIVE" ? "success" : "secondary"}
                      className="text-[10px]"
                    >
                      {agent.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                    {agent.tagline}
                  </p>
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <span>{formatPrice(agent.pricePerMonth)}/mo</span>
                    <span className="text-muted-foreground">
                      {agent._count.deployments} deployments
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
