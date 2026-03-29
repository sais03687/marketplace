"use client";

import Link from "next/link";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CapabilityBadge } from "./capability-badge";
import { Star, Users } from "lucide-react";
import { formatPrice } from "@/lib/utils";

interface AgentCardProps {
  agent: {
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
  };
  onHire?: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  SALES_OPERATIONS: "Sales Ops",
  CUSTOMER_SUCCESS: "Customer Success",
  EXECUTIVE_ASSISTANT: "Executive Assistant",
  RESEARCH: "Research",
  MARKETING_OPS: "Marketing Ops",
  HR_OPS: "HR Ops",
  FINANCE_OPS: "Finance Ops",
  ENGINEERING_OPS: "Engineering Ops",
  GENERAL: "General",
};

export function AgentCard({ agent, onHire }: AgentCardProps) {
  return (
    <Card className="flex flex-col transition-shadow hover:shadow-md">
      <CardContent className="flex-1 p-5">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="font-semibold leading-tight">{agent.name}</h3>
            {agent.creator && (
              <p className="text-xs text-muted-foreground">
                by {agent.creator.displayName}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            {agent.runtime === "CUSTOM" && (
              <Badge variant="outline" className="text-[10px] border-violet-300 text-violet-600">
                Custom
              </Badge>
            )}
            <Badge variant="secondary" className="text-[10px]">
              {CATEGORY_LABELS[agent.category] || agent.category}
            </Badge>
          </div>
        </div>

        <p className="mb-3 text-sm text-muted-foreground line-clamp-2">
          {agent.tagline}
        </p>

        <div className="mb-3 flex flex-wrap gap-1">
          {agent.capabilities.slice(0, 3).map((cap) => (
            <CapabilityBadge key={cap.name} name={cap.name} />
          ))}
          {agent.capabilities.length > 3 && (
            <span className="text-xs text-muted-foreground self-center">
              +{agent.capabilities.length - 3} more
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {agent.averageRating !== null && (
            <span className="flex items-center gap-1">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {agent.averageRating.toFixed(1)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Users className="h-3 w-3" />
            {agent.totalDeployments} hired
          </span>
        </div>
      </CardContent>

      <CardFooter className="flex items-center justify-between border-t p-4">
        <span className="text-lg font-bold">
          {formatPrice(agent.pricePerMonth)}
          <span className="text-xs font-normal text-muted-foreground">
            /mo
          </span>
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/agents/${agent.slug}`}>Preview</Link>
          </Button>
          <Button size="sm" onClick={onHire}>
            Hire
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
