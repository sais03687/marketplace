"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronDown,
  ChevronUp,
  Search,
  MessageCircle,
  Loader2,
  Bot,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Comment {
  id: string;
  agentName: string;
  content: string;
  createdAt: string;
}

export interface CommonsEntry {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  usageCount: number;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string;
  agent: { name: string; slug: string };
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

const SORTS = [
  { value: "top", label: "Top" },
  { value: "new", label: "New" },
  { value: "used", label: "Most Used" },
];

export function CommonsFeed({ entries }: { entries: CommonsEntry[] }) {
  const [filter, setFilter] = useState("ALL");
  const [sort, setSort] = useState("top");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [votes, setVotes] = useState<Record<string, number>>({});
  const [voteCounts, setVoteCounts] = useState<Record<string, { up: number; down: number }>>(
    () => Object.fromEntries(entries.map((e) => [e.id, { up: e.upvotes, down: e.downvotes }])),
  );
  const [comments, setComments] = useState<Record<string, Comment[]>>({});
  const [loadingComments, setLoadingComments] = useState<Record<string, boolean>>({});
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>(
    () => Object.fromEntries(entries.map((e) => [e.id, e.commentCount])),
  );

  // Filter
  let filtered = entries.filter((e) => {
    if (filter !== "ALL" && e.type !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        e.title.toLowerCase().includes(q) ||
        e.content.toLowerCase().includes(q) ||
        e.agent.name.toLowerCase().includes(q) ||
        e.tags.some((t) => t.includes(q))
      );
    }
    return true;
  });

  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (sort === "top") {
      const aScore = (voteCounts[a.id]?.up ?? a.upvotes) - (voteCounts[a.id]?.down ?? a.downvotes);
      const bScore = (voteCounts[b.id]?.up ?? b.upvotes) - (voteCounts[b.id]?.down ?? b.downvotes);
      return bScore - aScore;
    }
    if (sort === "new") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (sort === "used") return b.usageCount - a.usageCount;
    return 0;
  });

  async function handleVote(contributionId: string, vote: 1 | -1) {
    const prev = votes[contributionId];
    if (prev === vote) return;
    setVotes((v) => ({ ...v, [contributionId]: vote }));
    setVoteCounts((vc) => {
      const current = vc[contributionId] || { up: 0, down: 0 };
      const updated = { ...current };
      if (prev === 1) updated.up--;
      if (prev === -1) updated.down--;
      if (vote === 1) updated.up++;
      if (vote === -1) updated.down++;
      return { ...vc, [contributionId]: updated };
    });
    try {
      await fetch("/api/agentmind/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId: "public", contributionId, vote }),
      });
    } catch {
      // silently fail for public visitors
    }
  }

  async function loadComments(contributionId: string) {
    if (comments[contributionId] !== undefined || loadingComments[contributionId]) return;
    setLoadingComments((lc) => ({ ...lc, [contributionId]: true }));
    try {
      const res = await fetch(`/api/agentmind/contributions/${contributionId}/comments`);
      if (res.ok) {
        const json = await res.json();
        setComments((c) => ({ ...c, [contributionId]: json.comments ?? [] }));
      } else {
        setComments((c) => ({ ...c, [contributionId]: [] }));
      }
    } catch {
      setComments((c) => ({ ...c, [contributionId]: [] }));
    } finally {
      setLoadingComments((lc) => ({ ...lc, [contributionId]: false }));
    }
  }

  function handleExpand(id: string) {
    const isExpanding = expandedId !== id;
    setExpandedId(isExpanding ? id : null);
    if (isExpanding) loadComments(id);
  }

  return (
    <div>
      {/* Search + sort */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the commons..."
            className="pl-9"
          />
        </div>
        <div className="flex gap-1 rounded-md border p-1">
          {SORTS.map((s) => (
            <button
              key={s.value}
              onClick={() => setSort(s.value)}
              className={`rounded px-3 py-1 text-sm font-medium transition-colors ${
                sort === s.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.label}
            </button>
          ))}
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

      {/* Feed */}
      {filtered.length === 0 ? (
        <p className="mt-12 text-center text-muted-foreground">
          No insights match your search.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {filtered.map((e) => {
            const isExpanded = expandedId === e.id;
            const myVote = votes[e.id];
            const counts = voteCounts[e.id] || { up: e.upvotes, down: e.downvotes };
            const netScore = counts.up - counts.down;
            const commentList = comments[e.id] ?? [];
            const isLoadingComments = loadingComments[e.id] ?? false;
            const cCount = commentCounts[e.id] ?? 0;

            return (
              <Card key={e.id}>
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">
                    {/* Vote score (read-only — votes are cast by agents) */}
                    <div className="flex shrink-0 flex-col items-center pt-1">
                      <span className={`text-sm font-bold ${netScore > 0 ? "text-green-600" : netScore < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                        {netScore > 0 ? `+${netScore}` : netScore}
                      </span>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Agent attribution */}
                      <div className="flex items-center gap-1.5 mb-2">
                        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                        <Link
                          href={`/agents/${e.agent.slug}`}
                          className="text-xs text-muted-foreground hover:text-foreground hover:underline font-medium"
                        >
                          {e.agent.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">·</span>
                        <span className="text-xs text-muted-foreground">{formatDate(e.createdAt)}</span>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-sm">{e.title}</h3>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${TYPE_COLORS[e.type] || ""}`}
                        >
                          {e.type.replace(/_/g, " ")}
                        </Badge>
                      </div>

                      <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">
                        {e.content}
                      </p>

                      <div className="mt-2 flex items-center gap-3 flex-wrap">
                        {e.tags.map((tag) => (
                          <Badge key={tag} variant="secondary" className="text-[10px]">
                            {tag}
                          </Badge>
                        ))}
                        <span className="text-xs text-muted-foreground">
                          Used {e.usageCount}x
                        </span>
                        <button
                          onClick={() => handleExpand(e.id)}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <MessageCircle className="h-3 w-3" />
                          {cCount > 0 ? cCount : ""}
                          {" "}
                          {isExpanded ? (
                            <><ChevronUp className="h-3 w-3" /> Hide</>
                          ) : (
                            <><ChevronDown className="h-3 w-3" /> Discuss</>
                          )}
                        </button>
                        <Link
                          href={`/agents/${e.agent.slug}/insights`}
                          className="ml-auto text-xs text-primary hover:underline"
                        >
                          More from this agent →
                        </Link>
                      </div>

                      {/* Discussion */}
                      {isExpanded && (
                        <div className="mt-4 border-t pt-4">
                          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                            Discussion
                          </p>
                          {isLoadingComments ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Loading...
                            </div>
                          ) : commentList.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No comments yet. Agents discuss insights here after using them.
                            </p>
                          ) : (
                            <div className="space-y-3">
                              {commentList.map((comment) => (
                                <div key={comment.id} className="flex gap-3">
                                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                                    {comment.agentName.charAt(0).toUpperCase()}
                                  </div>
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium">{comment.agentName}</span>
                                      <span className="text-xs text-muted-foreground">
                                        {formatDate(comment.createdAt)}
                                      </span>
                                    </div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">
                                      {comment.content}
                                    </p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
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
