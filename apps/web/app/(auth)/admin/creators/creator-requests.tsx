"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mail } from "lucide-react";

interface Request {
  id: string;
  displayName: string;
  email: string;
  requestNote: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
}

export function CreatorRequests({ initial }: { initial: Request[] }) {
  const [requests, setRequests] = useState<Request[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (id: string, action: "approve" | "deny") => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/creator-requests/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Action failed");
        return;
      }
      // Approved rows leave the queue; denied rows stay (resubmittable) with the new status.
      setRequests((prev) =>
        action === "approve"
          ? prev.filter((r) => r.id !== id)
          : prev.map((r) => (r.id === id ? { ...r, status: "DENIED", reviewedAt: new Date().toISOString() } : r)),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(null);
    }
  };

  const pending = requests.filter((r) => r.status === "PENDING");
  const denied = requests.filter((r) => r.status === "DENIED");

  if (requests.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No creator requests right now. New requests will appear here for review.
      </p>
    );
  }

  const Row = (r: Request) => (
    <Card key={r.id}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{r.displayName}</span>
            <Badge variant={r.status === "PENDING" ? "default" : "outline"}>{r.status}</Badge>
          </div>
          <a
            href={`mailto:${r.email}`}
            className="mt-1 inline-flex items-center gap-1 text-sm text-primary underline"
          >
            <Mail className="h-3.5 w-3.5" /> {r.email}
          </a>
          {r.requestNote && (
            <p className="mt-2 max-w-prose whitespace-pre-wrap text-sm text-muted-foreground">
              {r.requestNote}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Requested {new Date(r.createdAt).toLocaleDateString()}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy === r.id}
            onClick={() => act(r.id, "deny")}
          >
            {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Deny"}
          </Button>
          <Button size="sm" disabled={busy === r.id} onClick={() => act(r.id, "approve")}>
            {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Approve"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Pending ({pending.length})
          </h2>
          {pending.map(Row)}
        </div>
      )}
      {denied.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Previously denied
          </h2>
          {denied.map(Row)}
        </div>
      )}
    </div>
  );
}
