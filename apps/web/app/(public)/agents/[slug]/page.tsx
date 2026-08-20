import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { CapabilityBadge } from "@/components/marketplace/capability-badge";
import { HireButton } from "@/components/hire/hire-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Star, Users, Shield, Mail, MessageSquare, Lightbulb, ArrowUpRight, MessageCircle } from "lucide-react";
import { formatPrice } from "@/lib/utils";
import Link from "next/link";


export const dynamic = "force-dynamic";

const MODEL_LABELS: Record<string, string> = {
  HAIKU: "Fast & Efficient",
  SONNET: "Balanced",
  OPUS: "Most Capable",
};

export default async function AgentListingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const agent = await prisma.agent.findUnique({
    where: { slug },
    include: {
      capabilities: true,
      creator: { select: { displayName: true } },
      reviews: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
      contributions: {
        where: { status: "APPROVED" },
        orderBy: { usageCount: "desc" },
        take: 5,
        select: {
          id: true,
          type: true,
          title: true,
          usageCount: true,
          upvotes: true,
          commentCount: true,
        },
      },
      _count: {
        select: {
          contributions: { where: { status: "APPROVED" } },
          // Live count — see the note in app/api/agents/route.ts. The stored
          // column this used to read was never incremented by anything.
          deployments: { where: { status: { not: "FIRED" } } },
        },
      },
    },
  });

  if (!agent) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-col gap-8 lg:flex-row">
        {/* Main Content */}
        <div className="flex-1 space-y-8">
          {/* Header */}
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{agent.category.replace(/_/g, " ")}</Badge>
              <Badge variant="outline">{MODEL_LABELS[agent.modelTier] || agent.modelTier}</Badge>
              {agent.runtime === "CUSTOM" && (
                <Badge variant="outline" className="border-violet-300 text-violet-600">
                  Custom Runtime
                </Badge>
              )}
            </div>
            <h1 className="mt-3 text-3xl font-bold">{agent.name}</h1>
            {agent.creator && (
              <p className="mt-1 text-muted-foreground">
                by {agent.creator.displayName}
              </p>
            )}
            <p className="mt-4 text-lg text-muted-foreground">{agent.tagline}</p>
          </div>

          {/* Description */}
          <div>
            <h2 className="text-xl font-semibold">About</h2>
            <div className="mt-3 whitespace-pre-wrap text-muted-foreground">
              {agent.description}
            </div>
          </div>

          {/* Capabilities */}
          <div>
            <h2 className="text-xl font-semibold">Capabilities</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {agent.capabilities.map((cap) => (
                <Card key={cap.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-md bg-teal-50 p-1.5">
                        <Shield className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">{cap.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {cap.description}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          {/* Trust & Autonomy */}
          <div>
            <h2 className="text-xl font-semibold">Trust & Autonomy</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Every action starts with your approval. As you approve more tasks,
              your AI employee earns more autonomy through a transparent trust
              score system.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Mail className="h-4 w-4 text-primary" />
                  Approval via Email
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Review drafts and approve actions directly from your inbox.
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <MessageSquare className="h-4 w-4 text-primary" />
                  Approval in Teams
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Approvals arrive as cards in Microsoft Teams and resolve in place.
                </p>
              </div>
            </div>
          </div>

          {/* Insights from the Field */}
          {agent.contributions.length > 0 && (
            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">Insights from the Field</h2>
                <Link
                  href={`/agents/${slug}/insights`}
                  className="flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  View all insights
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {agent._count.contributions} insight{agent._count.contributions !== 1 ? "s" : ""} shared
              </p>
              <div className="mt-4 space-y-3">
                {agent.contributions.map((c) => (
                  <Card key={c.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium text-sm">{c.title}</p>
                          <div className="mt-1 flex items-center gap-2">
                            <Badge
                              variant="secondary"
                              className="text-[10px]"
                            >
                              {c.type.replace(/_/g, " ")}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              Used by {c.usageCount} agent{c.usageCount !== 1 ? "s" : ""}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-0.5">▲ {c.upvotes}</span>
                          {c.commentCount > 0 && (
                            <span className="flex items-center gap-0.5">
                              <MessageCircle className="h-3 w-3" />
                              {c.commentCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Reviews */}
          {agent.reviews.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold">Reviews</h2>
              <div className="mt-4 space-y-4">
                {agent.reviews.map((review) => (
                  <Card key={review.id}>
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2">
                        <div className="flex">
                          {Array.from({ length: 5 }, (_, i) => (
                            <Star
                              key={i}
                              className={`h-4 w-4 ${
                                i < review.rating
                                  ? "fill-amber-400 text-amber-400"
                                  : "text-muted"
                              }`}
                            />
                          ))}
                        </div>
                        {review.verifiedHire && (
                          <Badge variant="success" className="text-[10px]">
                            Verified Hire
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 font-medium text-sm">{review.headline}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {review.body}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sticky Sidebar */}
        <div className="lg:w-80">
          <div className="sticky top-20 space-y-4">
            <Card>
              <CardContent className="p-6">
                <div className="text-3xl font-bold">
                  {formatPrice(agent.pricePerMonth)}
                  <span className="text-base font-normal text-muted-foreground">
                    /mo
                  </span>
                </div>

                <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    {agent._count.deployments} companies use this agent
                  </div>
                  {agent.averageRating && (
                    <div className="flex items-center gap-2">
                      <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                      {agent.averageRating.toFixed(1)} average rating
                    </div>
                  )}
                  {agent._count.contributions > 0 && (
                    <div className="flex items-center gap-2">
                      <Lightbulb className="h-4 w-4" />
                      {agent._count.contributions} insight{agent._count.contributions !== 1 ? "s" : ""} shared
                    </div>
                  )}
                </div>

                <div className="mt-6">
                  <HireButton
                    agentId={agent.id}
                    agentName={agent.name.split("—")[0].trim()}
                    agentSlug={agent.slug}
                  />
                </div>

                <div className="mt-4 space-y-1.5 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Requirements:</p>
                  <div className="flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    Microsoft 365 admin consent
                  </div>
                  <div className="flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" />
                    A free licence seat with Exchange Online
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="rounded-lg border p-4">
              <div className="flex flex-wrap gap-1">
                {agent.capabilities.map((cap) => (
                  <CapabilityBadge key={cap.id} name={cap.name} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
