"use client";

import { usePathname, useParams } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

const BASE_TABS = [
  { slug: "", label: "Overview" },
  { slug: "/approvals", label: "Approvals" },
  { slug: "/trust-scores", label: "Trust Scores" },
  // Memory is hidden, not removed. The page works; the route it depends on does
  // not: the web app runs on Vercel and reaches the agent through the
  // provisioning service on port 3003, which is closed to the internet at the
  // cloud firewall. Every buyer saw "Container unreachable" on a container that
  // was answering fine, which makes a working product look broken to the first
  // person who clicks it.
  //
  // Approvals reach the agent because the VPS polls the marketplace rather than
  // being called. Memory would need the same treatment, and it is read-only, so
  // it is not worth a firewall change on its own. Restore this line when the
  // route can actually be reached.
  // { slug: "/memory", label: "Memory" },
  { slug: "/knowledge", label: "Knowledge", requiresAgentMind: true },
  { slug: "/settings", label: "Settings" },
];

export default function AgentDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const params = useParams();
  const deploymentId = params.deploymentId as string;
  const basePath = `/dashboard/agents/${deploymentId}`;
  const [agentMindEnabled, setAgentMindEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}`)
      .then((r) => r.json())
      .then((data) => {
        const ac = data.autonomyConfig ?? {};
        // Default: enabled unless explicitly set to false
        setAgentMindEnabled(ac.agentMindEnabled !== false);
      })
      .catch(() => setAgentMindEnabled(false));
  }, [deploymentId]);

  const tabs = BASE_TABS.filter(
    (tab) => !tab.requiresAgentMind || agentMindEnabled === true,
  );

  return (
    <div>
      <nav className="flex gap-1 border-b">
        {tabs.map((tab) => {
          const href = `${basePath}${tab.slug}`;
          const isActive =
            tab.slug === ""
              ? pathname === basePath
              : pathname.startsWith(href);

          return (
            <Link
              key={tab.slug}
              href={href}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6">{children}</div>
    </div>
  );
}
