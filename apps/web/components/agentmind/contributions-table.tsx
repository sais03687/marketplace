"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Contribution {
  id: string;
  type: string;
  title: string;
  content: string;
  status: string;
  tags: string[];
  usageCount: number;
  upvotes: number;
  downvotes: number;
  sanitizationLog: unknown;
  reviewNote: string | null;
  createdAt: string;
  deployment: { agentName: string };
  agent: { name: string };
}

const STATUS_VARIANT: Record<string, "secondary" | "success" | "destructive" | "warning"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "destructive",
};

const TYPE_COLORS: Record<string, string> = {
  CORRECTION: "bg-blue-50 text-blue-700 border-blue-200",
  PATTERN: "bg-emerald-50 text-emerald-700 border-emerald-200",
  RESPONSE_TEMPLATE: "bg-violet-50 text-violet-700 border-violet-200",
  TASK_RECIPE: "bg-amber-50 text-amber-700 border-amber-200",
};

export function ContributionsTable({
  contributions,
}: {
  contributions: Contribution[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("ALL");

  const filtered = filter === "ALL"
    ? contributions
    : contributions.filter((c) => c.status === filter);

  return (
    <div className="mt-6">
      {/* Filter tabs */}
      <div className="mb-4 flex gap-1 border-b">
        {["ALL", "PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              filter === s
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          No contributions match this filter.
        </p>
      ) : (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="w-8 px-2 py-3" />
                <th className="px-4 py-3 text-left font-medium">Title</th>
                <th className="px-4 py-3 text-left font-medium">Agent</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Usage</th>
                <th className="px-4 py-3 text-right font-medium">Votes</th>
                <th className="px-4 py-3 text-right font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const isExpanded = expandedId === c.id;
                return (
                  <>
                    <tr
                      key={c.id}
                      onClick={() => setExpandedId(isExpanded ? null : c.id)}
                      className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-2 py-3 text-muted-foreground">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium">{c.title}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {c.deployment.agentName}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${TYPE_COLORS[c.type] || ""}`}
                        >
                          {c.type.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={STATUS_VARIANT[c.status] || "secondary"}
                          className="text-[10px]"
                        >
                          {c.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {c.usageCount}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        ▲ {c.upvotes} ▼ {c.downvotes}
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {formatDate(c.createdAt)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${c.id}-detail`} className="border-b last:border-0">
                        <td colSpan={8} className="bg-muted/20 px-6 py-4">
                          <div className="space-y-3">
                            <div>
                              <p className="text-xs font-medium text-muted-foreground">
                                Content
                              </p>
                              <p className="mt-1 whitespace-pre-wrap text-sm">
                                {c.content}
                              </p>
                            </div>
                            {c.tags.length > 0 && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground">
                                  Tags
                                </p>
                                <div className="mt-1 flex gap-1">
                                  {c.tags.map((tag) => (
                                    <Badge key={tag} variant="outline" className="text-[10px]">
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                            {c.reviewNote && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground">
                                  Review Note
                                </p>
                                <p className="mt-1 text-sm">{c.reviewNote}</p>
                              </div>
                            )}
                            {Array.isArray(c.sanitizationLog) && (
                              <div>
                                <p className="text-xs font-medium text-muted-foreground">
                                  Sanitization Log
                                </p>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {(
                                    c.sanitizationLog as {
                                      stage: string;
                                      action: string;
                                      details?: string;
                                    }[]
                                  ).map((entry, i) => (
                                    <Badge
                                      key={i}
                                      variant={
                                        entry.action === "redacted"
                                          ? "destructive"
                                          : "secondary"
                                      }
                                      className="text-[10px]"
                                    >
                                      {entry.stage}: {entry.action}
                                      {entry.details ? ` (${entry.details})` : ""}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
