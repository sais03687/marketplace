"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { ChevronDown, ChevronRight, Check, X } from "lucide-react";

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
  const [statuses, setStatuses] = useState<Record<string, string>>(
    () => Object.fromEntries(contributions.map((c) => [c.id, c.status]))
  );
  const [reviewing, setReviewing] = useState<Record<string, boolean>>({});

  const filtered = filter === "ALL"
    ? contributions
    : contributions.filter((c) => (statuses[c.id] ?? c.status) === filter);

  async function handleReview(id: string, decision: "APPROVED" | "REJECTED") {
    setReviewing((r) => ({ ...r, [id]: true }));
    try {
      const res = await fetch(`/api/agentmind/contributions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (res.ok) {
        setStatuses((s) => ({ ...s, [id]: decision }));
      }
    } finally {
      setReviewing((r) => ({ ...r, [id]: false }));
    }
  }

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
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const isExpanded = expandedId === c.id;
                const currentStatus = statuses[c.id] ?? c.status;
                const isReviewing = reviewing[c.id] ?? false;
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
                          variant={STATUS_VARIANT[currentStatus] || "secondary"}
                          className="text-[10px]"
                        >
                          {currentStatus}
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
                      <td
                        className="px-4 py-3 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {currentStatus === "PENDING" ? (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-green-600 hover:bg-green-50 hover:text-green-700"
                              disabled={isReviewing}
                              onClick={() => handleReview(c.id, "APPROVED")}
                              title="Approve — publish to AgentMind"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
                              disabled={isReviewing}
                              onClick={() => handleReview(c.id, "REJECTED")}
                              title="Reject — keep private"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${c.id}-detail`} className="border-b last:border-0">
                        <td colSpan={9} className="bg-muted/20 px-6 py-4">
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
                            {currentStatus === "PENDING" && (
                              <div className="flex gap-2 pt-1">
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="gap-1"
                                  disabled={isReviewing}
                                  onClick={() => handleReview(c.id, "APPROVED")}
                                >
                                  <Check className="h-3.5 w-3.5" />
                                  Approve & publish
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="gap-1 text-red-600 hover:bg-red-50 hover:text-red-700"
                                  disabled={isReviewing}
                                  onClick={() => handleReview(c.id, "REJECTED")}
                                >
                                  <X className="h-3.5 w-3.5" />
                                  Reject & keep private
                                </Button>
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
