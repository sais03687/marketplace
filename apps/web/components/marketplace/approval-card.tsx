"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RiskScoreBadge } from "./risk-score-badge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";

interface ApprovalCardProps {
  approval: {
    id: string;
    taskType: string;
    channel: string;
    draft: string;
    reasoning: string;
    originalRequest: string;
    combinedScore: number;
    status: string;
    createdAt: string;
    expiresAt: string;
  };
  onResolve: (
    approvalId: string,
    action: "APPROVED" | "EDITED" | "REJECTED",
    data?: { editedText?: string; rejectionReason?: string },
  ) => void;
  isExpanded?: boolean;
  isFocused?: boolean;
}

export function ApprovalCard({
  approval,
  onResolve,
  isExpanded: initialExpanded = false,
  isFocused = false,
}: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [editMode, setEditMode] = useState(false);
  const [editedText, setEditedText] = useState(approval.draft);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const isPending = approval.status === "PENDING";

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors",
        isFocused && "ring-2 ring-primary",
        !isPending && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{approval.taskType}</span>
          <Badge variant="secondary" className="text-[10px]">
            {approval.channel}
          </Badge>
          <RiskScoreBadge score={approval.combinedScore} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {timeAgo(approval.createdAt)}
          </span>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Original Request
            </p>
            <p className="text-sm bg-muted rounded-md p-2">
              {approval.originalRequest}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Draft
            </p>
            {editMode ? (
              <Textarea
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                className="text-sm"
                rows={6}
              />
            ) : (
              <div className="text-sm bg-muted rounded-md p-2 whitespace-pre-wrap">
                {approval.draft}
              </div>
            )}
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">
              Reasoning
            </p>
            <p className="text-sm text-muted-foreground bg-muted/50 rounded-md p-2">
              {approval.reasoning}
            </p>
          </div>

          {rejectMode && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Rejection Reason
              </p>
              <Textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="Why is this being rejected?"
                className="text-sm"
                rows={2}
              />
            </div>
          )}

          {isPending && (
            <div className="flex items-center gap-2 pt-2">
              {editMode ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      onResolve(approval.id, "EDITED", { editedText });
                      setEditMode(false);
                    }}
                  >
                    Submit Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditMode(false);
                      setEditedText(approval.draft);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : rejectMode ? (
                <>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      onResolve(approval.id, "REJECTED", { rejectionReason });
                      setRejectMode(false);
                    }}
                  >
                    Confirm Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejectMode(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    onClick={() => onResolve(approval.id, "APPROVED")}
                  >
                    Approve
                    <kbd className="ml-1 text-[10px] opacity-50">a</kbd>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditMode(true)}
                  >
                    Edit
                    <kbd className="ml-1 text-[10px] opacity-50">e</kbd>
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setRejectMode(true)}
                  >
                    Reject
                    <kbd className="ml-1 text-[10px] opacity-50">r</kbd>
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
