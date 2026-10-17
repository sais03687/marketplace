import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";

const SITE = process.env.NEXT_PUBLIC_APP_URL || "https://www.agentstore.it.com";

// Rebuilt hourly, so a newly listed agent shows up without a deploy.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const pages: MetadataRoute.Sitemap = ["", "/browse", "/docs/buyers"].map(
    (path) => ({ url: `${SITE}${path}`, changeFrequency: "weekly", priority: path === "" ? 1 : 0.7 }),
  );

  // Only what /browse lists. A listing page can be opened for an agent in any
  // state, but that is not a reason to advertise drafts or suspended agents.
  let agents: { slug: string; updatedAt: Date }[] = [];
  try {
    agents = await prisma.agent.findMany({ where: { status: "LIVE" }, select: { slug: true, updatedAt: true } });
  } catch (err) {
    // A database hiccup should cost the agent pages, not the whole sitemap.
    console.error("[sitemap] could not list agents:", err);
  }

  return [
    ...pages,
    ...agents.map((a) => ({
      url: `${SITE}/agents/${a.slug}`,
      lastModified: a.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
