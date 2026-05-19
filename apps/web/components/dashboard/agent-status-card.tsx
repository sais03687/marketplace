"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ArrowUpCircle, AlertTriangle } from "lucide-react";

interface AgentStatusCardProps {
  deployment: {
    id: string;
    agentName: string;
    status: string;
    onboardingState: string;
    pauseReason?: string | null;
    agent: {
      name: string;
      slug: string;
      currentVersion?: string | null;
    };
    agentVersion?: string;
    _count?: {
      approvals: number;
    };
  };
  updateAvailable?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  PROVISIONING: "bg-blue-100 text-blue-800",
  ONBOARDING: "bg-amber-100 text-amber-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  PAUSED: "bg-gray-100 text-gray-800",
  FIRED: "bg-red-100 text-red-800",
  ERROR: "bg-red-100 text-red-800",
};

export function AgentStatusCard({ deployment, updateAvailable }: AgentStatusCardProps) {
  const pendingCount = deployment._count?.approvals ?? 0;
  const showUpdateBadge = updateAvailable && deployment.status === "ACTIVE";
  const showPauseReason = deployment.status === "PAUSED" && !!deployment.pauseReason;

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

          {showPauseReason && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="line-clamp-1">{deployment.pauseReason}</span>
            </div>
          )}

          <div className="mt-3 flex items-center gap-3 text-sm">
            {pendingCount > 0 && (
              <div className="flex items-center gap-1">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                  {pendingCount}
                </span>
                <span className="text-muted-foreground">pending</span>
              </div>
            )}
            {showUpdateBadge && (
              <div className="flex items-center gap-1 text-blue-600">
                <ArrowUpCircle className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Update available</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
