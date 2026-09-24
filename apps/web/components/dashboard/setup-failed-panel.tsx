"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, AlertTriangle } from "lucide-react";

/**
 * Setup failed, so say so — and offer the way out.
 *
 * A hire that failed used to look identical to one that worked: the dashboard
 * said "Your agent is ready. Provisioning is complete." while the agent had no
 * mailbox. The only escape was to fire it and hire again, which started a
 * second subscription for the same agent.
 */
export function SetupFailedPanel({
  deploymentId,
  reason,
}: {
  deploymentId: string;
  reason?: string | null;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/retry`, { method: "POST" });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body?.error ?? "Could not start setup again. Please try in a moment.");
    } catch {
      setError("Network error. Please try again.");
    }
    setRetrying(false);
  };

  return (
    <Card className="border-destructive/40">
      <CardContent className="space-y-4 p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" />
          <div className="space-y-1">
            <h3 className="text-lg font-semibold">Setup did not finish</h3>
            <p className="text-sm text-muted-foreground">
              This agent was not fully built, so it cannot receive or send email yet.
              You have not been charged for it — billing stops unless setup completes.
            </p>
          </div>
        </div>

        {reason && (
          <pre className="max-h-40 overflow-auto rounded bg-muted p-3 text-xs">{reason}</pre>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center gap-3">
          <Button onClick={retry} disabled={retrying}>
            {retrying ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Retry setup
          </Button>
          <p className="text-xs text-muted-foreground">
            Retrying uses the hire you already have — it does not charge you again.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
