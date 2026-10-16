import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL || "https://www.agentstore.it.com";

/**
 * Public pages are open to crawlers; everything a signed-in user or an agent
 * reaches is not. Disallow is a request, not access control — those routes are
 * protected by auth regardless — it just keeps them out of search results.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard", "/creator", "/admin", "/approve", "/sign-in", "/sign-up"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
