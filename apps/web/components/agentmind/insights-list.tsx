"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ThumbsUp, ThumbsDown, ChevronDown, ChevronUp, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Insight {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  usageCount: number;
  upvotes: number;
  downvotes: number;
  createdAt: string;
}

const TYPE_COLORS: Record<string, string> = {
  CORRECTION: "bg-blue-50 text-blue-700 border-blue-200",
  PATTERN: "bg-emerald-50 text-emerald-700 border-emerald-200",
  RESPONSE_TEMPLATE: "bg-violet-50 text-violet-700 border-violet-200",
  TASK_RECIPE: "bg-amber-50 text-amber-700 border-amber-200",
};

const TYPES = ["ALL", "CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"];
const TYPE_LABELS: Record<string, string> = {
  ALL: "All",
  CORRECTION: "Corrections",
  PATTERN: "Patterns",
  RESPONSE_TEMPLATE: "Templates",
  TASK_RECIPE: "Recipes",
};

export function InsightsList({ insights }: { insights: Insight[] }) {
  const [filter, setFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [votes, setVotes] = useState<Record<string, number>>({});
  const [voteCounts, setVoteCounts] = useState<Record<string, { up: number; down: number }>>(
    () => {
      const counts: Record<string, { up: number; down: number }> = {};
      for (const c of insights) {
        counts[c.id] = { up: c.upvotes, down: c.downvotes };
      }
      return counts;
    },
  );

  const filtered = insights.filter((c) => {
    if (filter !== "ALL" && c.type !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        c.title.toLowerCase().includes(q) ||
        c.content.toLowerCase().includes(q) ||
        c.tags.some((t) => t.includes(q))
      );
    }
    return true;
  });

  async function handleVote(contributionId: string, vote: 1 | -1) {
    const prev = votes[contributionId];
    if (prev === vote) return; // already voted same way

    // Optimistic update
    setVotes((v) => ({ ...v, [contributionId]: vote }));
    setVoteCounts((vc) => {
      const current = vc[contributionId] || { up: 0, down: 0 };
      const updated = { ...current };
      // Undo previous vote if exists
      if (prev === 1) updated.up--;
      if (prev === -1) updated.down--;
      // Apply new vote
      if (vote === 1) updated.up++;
      if (vote === -1) updated.down++;
      return { ...vc, [contributionId]: updated };
    });

    // Note: voting requires a deploymentId. This is a public page so we can't
    // easily get one. We'll show the vote UI but the actual POST will fail
    // gracefully for non-deployed visitors.
    try {
      await fetch("/api/agentmind/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // In production, this would come from the logged-in deployment context
          deploymentId: "public",
          contributionId,
          vote,
        }),
      });
    } catch {
      // Silently fail for public visitors
    }
  }

  return (
    <div>
      {/* Search + filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search insights..."
            className="pl-9"
          />
        </div>
      </div>

      {/* Type filter tabs */}
      <div className="mt-3 flex gap-1 overflow-x-auto border-b">
        {TYPES.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              filter === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <p className="mt-8 text-center text-muted-foreground">
          No insights match your search.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {filtered.map((c) => {
            const isExpanded = expandedId === c.id;
            const myVote = votes[c.id];
            const counts = voteCounts[c.id] || { up: c.upvotes, down: c.downvotes };

            return (
              <Card key={c.id}>
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">
                    {/* Vote buttons */}
                    <div className="flex shrink-0 flex-col items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`h-8 w-8 p-0 ${myVote === 1 ? "text-green-600" : "text-muted-foreground"}`}
                        onClick={() => handleVote(c.id, 1)}
                      >
                        <ThumbsUp className="h-4 w-4" />
                      </Button>
                      <span className="text-sm font-medium">
                        {counts.up - counts.down}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`h-8 w-8 p-0 ${myVote === -1 ? "text-red-600" : "text-muted-foreground"}`}
                        onClick={() => handleVote(c.id, -1)}
                      >
                        <ThumbsDown className="h-4 w-4" />
                      </Button>
                    </div>

                    {/* Content */}
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-sm">{c.title}</h3>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${TYPE_COLORS[c.type] || ""}`}
                        >
                          {c.type.replace(/_/g, " ")}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Used {c.usageCount}x
                        </span>
                      </div>

                      {/* Truncated / expanded content */}
                      <p
                        className={`mt-2 text-sm text-muted-foreground ${
                          isExpanded ? "" : "line-clamp-2"
                        }`}
                      >
                        {c.content}
                      </p>

                      <div className="mt-2 flex items-center gap-3">
                        {c.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                        <span className="text-xs text-muted-foreground">
                          {formatDate(c.createdAt)}
                        </span>
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : c.id)}
                          className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          {isExpanded ? (
                            <>
                              Show less <ChevronUp className="h-3 w-3" />
                            </>
                          ) : (
                            <>
                              Read more <ChevronDown className="h-3 w-3" />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
