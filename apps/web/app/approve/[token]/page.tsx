"use client";

import { useState, useEffect, use } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, X, Pencil } from "lucide-react";
import { timeAgo } from "@/lib/utils";

interface Approval {
  id: string;
  taskType: string;
  channel: string;
  draft: string;
  reasoning: string;
  originalRequest: string;
  combinedScore: number;
  createdAt: string;
}

interface PortalData {
  agentName: string;
  agentSlug: string;
  deploymentId: string;
  approvals: Approval[];
}

export default function ApprovalPortalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const fetchData = async () => {
    try {
      const res = await fetch(`/api/portal/${token}/approvals`);
      if (res.ok) {
        setData(await res.json());
      } else {
        setError("Invalid or expired approval link.");
      }
    } catch {
      setError("Failed to load approvals.");
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [token]);

  const resolve = async (
    approvalId: string,
    action: "APPROVED" | "EDITED" | "REJECTED",
  ) => {
    setResolving(approvalId);
    try {
      const body: Record<string, string> = { action };
      if (action === "EDITED") body.editedText = editText;
      if (action === "REJECTED") body.rejectionReason = rejectReason;

      const res = await fetch(
        `/api/portal/${token}/approvals/${approvalId}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );

      if (res.ok) {
        setEditingId(null);
        setRejectingId(null);
        setEditText("");
        setRejectReason("");
        await fetchData();
      }
    } catch {
      // retry silently
    }
    setResolving(null);
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold">Approval Portal</h1>
          <p className="mt-2 text-muted-foreground">
            {error || "Something went wrong."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{data.agentName}</h1>
          <p className="text-muted-foreground">
            Pending approvals for review
          </p>
        </div>

        {data.approvals.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <Check className="mx-auto h-8 w-8 text-emerald-500" />
              <p className="mt-2 font-medium">All caught up!</p>
              <p className="text-sm text-muted-foreground">
                No pending approvals at this time.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {data.approvals.map((approval) => (
              <Card key={approval.id}>
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline">{approval.taskType}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(approval.createdAt)}
                    </span>
                  </div>

                  <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">
                    {approval.draft}
                  </div>

                  {approval.reasoning && (
                    <p className="text-xs text-muted-foreground">
                      Reasoning: {approval.reasoning}
                    </p>
                  )}

                  {editingId === approval.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        placeholder="Edit the draft..."
                        rows={4}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => resolve(approval.id, "EDITED")}
                          disabled={resolving === approval.id || !editText}
                        >
                          {resolving === approval.id && (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          )}
                          Submit Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : rejectingId === approval.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Reason for rejection..."
                        rows={2}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => resolve(approval.id, "REJECTED")}
                          disabled={resolving === approval.id}
                        >
                          {resolving === approval.id && (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          )}
                          Confirm Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRejectingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => resolve(approval.id, "APPROVED")}
                        disabled={resolving === approval.id}
                      >
                        {resolving === approval.id ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        ) : (
                          <Check className="mr-1 h-3 w-3" />
                        )}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingId(approval.id);
                          setEditText(approval.draft);
                        }}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRejectingId(approval.id)}
                      >
                        <X className="mr-1 h-3 w-3" />
                        Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
