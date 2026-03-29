import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function VettingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  // In production, check admin role via Clerk metadata
  const versions = await prisma.agentVersion.findMany({
    where: { vetStatus: { in: ["PENDING", "PASSED"] } },
    include: {
      agent: {
        include: { creator: { select: { displayName: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold">Admin: Agent Vetting</h1>
      <p className="text-muted-foreground">
        Review and approve submitted agent packages.
      </p>

      {versions.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium">No packages to review</p>
          <p className="text-muted-foreground">
            All submitted packages have been reviewed.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {versions.map((version) => (
            <Card key={version.id}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold">{version.agent.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      by {version.agent.creator.displayName} &middot; v
                      {version.version}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {version.agent.tagline}
                    </p>
                  </div>
                  <Badge
                    variant={
                      version.vetStatus === "PASSED" ? "success" : "warning"
                    }
                    className="text-[10px]"
                  >
                    {version.vetStatus}
                  </Badge>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    Submitted {formatDate(version.createdAt)}
                  </span>
                  <div className="flex gap-2">
                    <form
                      action={`/api/packages/${version.id}/vet-decision`}
                      method="POST"
                    >
                      <input
                        type="hidden"
                        name="decision"
                        value="MANUALLY_APPROVED"
                      />
                      <Button size="sm">Approve</Button>
                    </form>
                    <form
                      action={`/api/packages/${version.id}/vet-decision`}
                      method="POST"
                    >
                      <input type="hidden" name="decision" value="FAILED" />
                      <Button size="sm" variant="destructive">
                        Reject
                      </Button>
                    </form>
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
