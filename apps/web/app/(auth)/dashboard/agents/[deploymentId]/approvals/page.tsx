"use client";

import { useState, useEffect, useCallback, use } from "react";
import { ApprovalCard } from "@/components/marketplace/approval-card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface Approval {
  id: string;
  deploymentId: string;
  taskType: string;
  channel: string;
  draft: string;
  reasoning: string;
  originalRequest: string;
  combinedScore: number;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export default function DeploymentApprovalsPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = use(params);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/approvals`);
      if (res.ok) {
        const data = await res.json();
        setApprovals(Array.isArray(data) ? data : []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [deploymentId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const handleResolve = async (
    approvalId: string,
    action: "APPROVED" | "EDITED" | "REJECTED",
    data?: { editedText?: string; rejectionReason?: string },
  ) => {
    await fetch(`/api/deployments/${deploymentId}/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    });
    fetch_();
  };

  const pending = approvals.filter((a) => a.status === "PENDING");
  const resolved = approvals.filter((a) => a.status !== "PENDING");
  const shown = showResolved ? approvals : pending;

  const handleBulkApprove = async () => {
    for (const a of pending) await handleResolve(a.id, "APPROVED");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Approvals</h2>
          <p className="text-sm text-muted-foreground">
            {pending.length > 0
              ? `${pending.length} pending action${pending.length > 1 ? "s" : ""} waiting for review`
              : "No pending approvals"}
          </p>
        </div>
        {pending.length > 1 && (
          <Button size="sm" variant="outline" onClick={handleBulkApprove}>
            Approve all ({pending.length})
          </Button>
        )}
      </div>

      {shown.length === 0 && !showResolved && (
        <div className="rounded-lg border border-dashed py-12 text-center">
          <p className="text-sm font-medium">No pending approvals</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This agent hasn&apos;t submitted any actions for review yet.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {shown.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            isFocused={false}
            onResolve={(approvalId, action, data) => handleResolve(approvalId, action, data)}
          />
        ))}
      </div>

      {resolved.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "Hide resolved" : `Show resolved (${resolved.length})`}
        </Button>
      )}
    </div>
  );
}
