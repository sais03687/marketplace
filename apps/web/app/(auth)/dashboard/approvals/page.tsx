"use client";

import { useState, useEffect, useCallback } from "react";
import { ApprovalCard } from "@/components/marketplace/approval-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

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
  deployment?: { agentName: string };
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusIndex, setFocusIndex] = useState(0);
  const [filter, setFilter] = useState("");
  const [showResolved, setShowResolved] = useState(false);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await fetch("/api/deployments?includeApprovals=true");
      if (!res.ok) {
        setApprovals([]);
        return;
      }
      const data = await res.json();
      // Flatten approvals from all deployments
      if (Array.isArray(data)) {
        const all: Approval[] = [];
        for (const dep of data) {
          if (dep.approvals) {
            for (const a of dep.approvals) {
              all.push({ ...a, deployment: { agentName: dep.agentName } });
            }
          }
        }
        all.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        setApprovals(all);
      }
    } catch {
      setApprovals([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
        return;

      const pending = filteredApprovals.filter((a) => a.status === "PENDING");
      if (pending.length === 0) return;

      switch (e.key) {
        case "j":
          e.preventDefault();
          setFocusIndex((i) => Math.min(i + 1, pending.length - 1));
          break;
        case "k":
          e.preventDefault();
          setFocusIndex((i) => Math.max(i - 1, 0));
          break;
        case "a":
          e.preventDefault();
          handleResolve(pending[focusIndex].id, "APPROVED", pending[focusIndex].deploymentId);
          break;
        case "e":
          // Edit mode handled in ApprovalCard
          break;
        case "r":
          e.preventDefault();
          handleResolve(pending[focusIndex].id, "REJECTED", pending[focusIndex].deploymentId, {
            rejectionReason: "Rejected via keyboard shortcut",
          });
          break;
        case "Escape":
          setFocusIndex(0);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  const handleResolve = async (
    approvalId: string,
    action: "APPROVED" | "EDITED" | "REJECTED",
    deploymentId: string,
    data?: { editedText?: string; rejectionReason?: string },
  ) => {
    try {
      await fetch(
        `/api/deployments/${deploymentId}/approvals/${approvalId}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...data }),
        },
      );
      fetchApprovals();
    } catch {
      // Handle error
    }
  };

  const handleBulkAction = async (action: "APPROVED" | "REJECTED") => {
    const pending = filteredApprovals.filter((a) => a.status === "PENDING");
    for (const approval of pending) {
      await handleResolve(approval.id, action, approval.deploymentId);
    }
  };

  const filteredApprovals = approvals.filter((a) => {
    // Status filter: only show PENDING by default
    if (!showResolved && a.status !== "PENDING") return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      a.taskType.toLowerCase().includes(q) ||
      a.channel.toLowerCase().includes(q) ||
      a.deployment?.agentName?.toLowerCase().includes(q)
    );
  });

  const pendingCount = approvals.filter((a) => a.status === "PENDING").length;
  const resolvedCount = approvals.filter((a) => a.status !== "PENDING").length;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Approvals</h1>
          <p className="text-muted-foreground">
            Review and resolve pending actions from your AI employees.
          </p>
        </div>
        {pendingCount > 0 && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleBulkAction("APPROVED")}
            >
              Approve All ({pendingCount})
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleBulkAction("REJECTED")}
            >
              Reject All
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-4">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by agent, task type..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        {resolvedCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowResolved(!showResolved)}
            className="text-muted-foreground"
          >
            {showResolved
              ? "Hide resolved"
              : `Show resolved (${resolvedCount})`}
          </Button>
        )}
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        Keyboard: <kbd className="rounded border px-1">j</kbd>/
        <kbd className="rounded border px-1">k</kbd> navigate,{" "}
        <kbd className="rounded border px-1">a</kbd> approve,{" "}
        <kbd className="rounded border px-1">e</kbd> edit,{" "}
        <kbd className="rounded border px-1">r</kbd> reject
      </div>

      {loading ? (
        <div className="mt-12 text-center text-muted-foreground">
          Loading approvals...
        </div>
      ) : filteredApprovals.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-lg font-medium">No approvals</p>
          <p className="mt-1 text-muted-foreground">
            Your AI employees haven&apos;t submitted any actions for review yet.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {filteredApprovals.map((approval, i) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              isFocused={
                i ===
                filteredApprovals
                  .filter((a) => a.status === "PENDING")
                  .indexOf(approval) &&
                i === focusIndex
              }
              onResolve={(id, action, data) =>
                handleResolve(id, action, approval.deploymentId, data)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
