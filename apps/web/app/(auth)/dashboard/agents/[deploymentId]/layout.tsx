"use client";

import { usePathname, useParams } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { slug: "", label: "Overview" },
  { slug: "/approvals", label: "Approvals" },
  { slug: "/trust-scores", label: "Trust Scores" },
  { slug: "/memory", label: "Memory" },
  { slug: "/knowledge", label: "Knowledge" },
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

  return (
    <div>
      <nav className="flex gap-1 border-b">
        {TABS.map((tab) => {
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
