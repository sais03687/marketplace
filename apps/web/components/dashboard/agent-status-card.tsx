"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface AgentStatusCardProps {
  deployment: {
    id: string;
    agentName: string;
    status: string;
    onboardingState: string;
    agent: {
      name: string;
      slug: string;
    };
    _count?: {
      approvals: number;
    };
  };
}

const STATUS_COLORS: Record<string, string> = {
  PROVISIONING: "bg-blue-100 text-blue-800",
  ONBOARDING: "bg-amber-100 text-amber-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  PAUSED: "bg-gray-100 text-gray-800",
  FIRED: "bg-red-100 text-red-800",
  ERROR: "bg-red-100 text-red-800",
};

export function AgentStatusCard({ deployment }: AgentStatusCardProps) {
  const pendingCount = deployment._count?.approvals ?? 0;

  return (
    <Link href={`/dashboard/agents/${deployment.id}`}>
      <Card className="transition-shadow hover:shadow-md">
        <CardContent className="p-5">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-semibold">{deployment.agentName}</h3>
              <p className="text-xs text-muted-foreground">
                {deployment.agent.name}
              </p>
            </div>
            <Badge
              className={cn(
                "text-[10px]",
                STATUS_COLORS[deployment.status] || "",
              )}
            >
              {deployment.status}
            </Badge>
          </div>

          <div className="mt-4 flex items-center gap-4 text-sm">
            {pendingCount > 0 && (
              <div className="flex items-center gap-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                  {pendingCount}
                </span>
                <span className="text-muted-foreground">pending</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
