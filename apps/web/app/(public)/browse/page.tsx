"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { AgentCard } from "@/components/marketplace/agent-card";
import { HireModal } from "@/components/hire/hire-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

const CATEGORIES = [
  { value: "", label: "All Categories" },
  { value: "GENERAL", label: "General" },
  { value: "SALES_OPERATIONS", label: "Sales Ops" },
  { value: "CUSTOMER_SUCCESS", label: "Customer Success" },
  { value: "EXECUTIVE_ASSISTANT", label: "Executive Assistant" },
  { value: "RESEARCH", label: "Research" },
  { value: "MARKETING_OPS", label: "Marketing Ops" },
  { value: "HR_OPS", label: "HR Ops" },
  { value: "FINANCE_OPS", label: "Finance Ops" },
  { value: "ENGINEERING_OPS", label: "Engineering Ops" },
  { value: "IT_SUPPORT", label: "IT Support" },
];

const SORT_OPTIONS = [
  { value: "popular", label: "Most Popular" },
  { value: "rating", label: "Highest Rated" },
  { value: "newest", label: "Newest" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
];

interface Agent {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  category: string;
  pricePerMonth: number;
  modelTier: string;
  runtime?: string;
  averageRating: number | null;
  totalDeployments: number;
  creator?: { displayName: string } | null;
  capabilities: Array<{ name: string }>;
}

export default function BrowsePage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("popular");
  const [hireAgent, setHireAgent] = useState<Agent | null>(null);
  const searchParams = useSearchParams();

  // Auto-open hire modal when returning from Microsoft OAuth callback
  useEffect(() => {
    if (searchParams.get("microsoft") === "connected" && agents.length > 0) {
      // Restore the agent from sessionStorage if possible
      const savedSlug = (() => {
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key?.startsWith("hire-state-")) return key.replace("hire-state-", "");
          }
        } catch {}
        return null;
      })();
      if (savedSlug) {
        const agent = agents.find((a) => a.slug === savedSlug);
        if (agent) setHireAgent(agent);
      }
    }
  }, [searchParams, agents]);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (category) params.set("category", category);
    if (sort) params.set("sort", sort);

    try {
      const res = await fetch(`/api/agents?${params}`);
      const data = await res.json();
      setAgents(data.agents || []);
    } catch {
      setAgents([]);
    }
    setLoading(false);
  }, [query, category, sort]);

  useEffect(() => {
    const timer = setTimeout(fetchAgents, 300);
    return () => clearTimeout(timer);
  }, [fetchAgents]);

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-3xl font-bold">Browse AI Employees</h1>
      <p className="mt-2 text-muted-foreground">
        Find the right hire for your team.
      </p>

      <div className="mt-8 flex flex-col gap-8 lg:flex-row">
        {/* Sidebar Filters */}
        <aside className="w-full shrink-0 space-y-6 lg:w-56">
          <div>
            <h3 className="mb-2 text-sm font-medium">Category</h3>
            <div className="space-y-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setCategory(cat.value)}
                  className={`block w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                    category === cat.value
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search agents..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9 sm:w-72"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <div className="mt-12 text-center text-muted-foreground">
              Loading agents...
            </div>
          ) : agents.length === 0 ? (
            <div className="mt-12 text-center">
              <p className="text-lg font-medium">No agents found</p>
              <p className="mt-1 text-muted-foreground">
                Try adjusting your search or filters.
              </p>
              {(query || category) && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => {
                    setQuery("");
                    setCategory("");
                  }}
                >
                  Clear Filters
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-6 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => (
                <AgentCard key={agent.slug} agent={agent} onHire={() => setHireAgent(agent)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {hireAgent && (
        <HireModal
          open={!!hireAgent}
          onOpenChange={(open) => { if (!open) setHireAgent(null); }}
          agentId={hireAgent.id}
          agentName={hireAgent.name}
          agentSlug={hireAgent.slug}
        />
      )}
    </div>
  );
}
