import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { VettingList } from "./vetting-list";

export const dynamic = "force-dynamic";

export default async function VettingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const versions = await prisma.agentVersion.findMany({
    where: { vetStatus: { in: ["PENDING", "PASSED"] } },
    include: {
      agent: {
        include: {
          creator: { select: { displayName: true } },
          capabilities: { select: { name: true, description: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  console.log("[vetting] versions found:", versions.length, versions.map(v => `${v.agent.slug}@${v.version} vetStatus=${v.vetStatus}`));

  // Serialize for client component
  const serialized = versions.map((v) => ({
    id: v.id,
    version: v.version,
    vetStatus: v.vetStatus,
    storagePath: v.storagePath,
    manifestData: v.manifestData as Record<string, unknown> | null,
    createdAt: v.createdAt.toISOString(),
    agent: {
      name: v.agent.name,
      slug: v.agent.slug,
      tagline: v.agent.tagline,
      description: v.agent.description,
      category: v.agent.category,
      runtime: v.agent.runtime,
      modelTier: v.agent.modelTier,
      pricePerMonth: v.agent.pricePerMonth,
      creator: v.agent.creator,
      capabilities: v.agent.capabilities,
    },
  }));

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">Admin: Agent Vetting</h1>
      <p className="text-muted-foreground">
        Review and approve submitted agent packages.
      </p>
      <VettingList versions={serialized} />
    </div>
  );
}
