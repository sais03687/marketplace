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
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

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
              all.push({
                ...a,
                // Carried explicitly: every resolve path builds its URL from
                // this, and when it was absent the request went to
                // /api/deployments/undefined/... — a 404 that fetch does not
                // throw on and the catch below discarded, so approvals looked
                // like they resolved and silently did nothing.
                deploymentId: a.deploymentId ?? dep.id,
                deployment: { agentName: dep.agentName },
              });
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

      // Same source as the bulk action and the cards, so the shortcuts cannot
      // act on a different list from the one on screen.
      const pending = approvals.filter((a) => a.status === "PENDING");
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
          // A question has no "approved" state — approving one resolves it with
          // no answer, and the agent resumes having learned nothing. There is
          // nothing this key can mean here, so it does nothing and the card's
          // own answer box is the only way through.
          if (pending[focusIndex].taskType === "decision_request") break;
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
    if (!deploymentId) {
      setResolveError(
        "This approval is missing its deployment, so it cannot be resolved. Reload the page.",
      );
      return false;
    }
    try {
      const res = await fetch(
        `/api/deployments/${deploymentId}/approvals/${approvalId}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...data }),
        },
      );
      // fetch only rejects on a network failure, so a 404 or a 500 arrives here
      // looking exactly like success. Swallowing that is what made a dead
      // Approve All indistinguishable from a working one.
      if (!res.ok) {
        setResolveError(
          `Could not resolve that approval (${res.status}). Nothing was changed.`,
        );
        return false;
      }
      setResolveError(null);
      await fetchApprovals();
      return true;
    } catch {
      setResolveError("Could not reach the server. Nothing was changed.");
      return false;
    }
  };

  const handleBulkAction = async (action: "APPROVED" | "REJECTED") => {
    // Snapshot before the first resolve: each one refetches, so reading the
    // live list mid-loop would work against a list that is changing underneath.
    const pending = approvals.filter((a) => a.status === "PENDING");
    if (pending.length === 0) return;
    // Questions are skipped by Approve All, never swept up by it. Approving a
    // question resolves it with no answer, so the agent resumes knowing exactly
    // as much as it did when it stopped to ask — and the buyer has no idea they
    // just discarded it. Rejecting one is a real decision ("I can't answer
    // that"), so bulk reject still includes them.
    const targets =
      action === "APPROVED"
        ? pending.filter((a) => a.taskType !== "decision_request")
        : pending;
    const skipped = pending.length - targets.length;
    if (targets.length === 0) {
      setResolveError(
        "Nothing to approve — the only items pending are questions, which need an answer.",
      );
      return;
    }
    setBulkBusy(true);
    let done = 0;
    for (const approval of targets) {
      const ok = await handleResolve(approval.id, action, approval.deploymentId);
      if (!ok) break; // stop rather than press on silently against a broken endpoint
      done++;
    }
    setBulkBusy(false);
    if (done < targets.length) {
      setResolveError(
        `Resolved ${done} of ${targets.length}. The rest were left pending.`,
      );
    } else if (skipped > 0) {
      setResolveError(
        `Resolved ${done}. ${skipped} question${skipped === 1 ? "" : "s"} left for you to answer.`,
      );
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
              disabled={bulkBusy}
              onClick={() => handleBulkAction("APPROVED")}
            >
              {bulkBusy ? "Approving…" : `Approve All (${pendingCount})`}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={bulkBusy}
              onClick={() => handleBulkAction("REJECTED")}
            >
              Reject All
            </Button>
          </div>
        )}
      </div>

      {resolveError && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {resolveError}
        </div>
      )}

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
