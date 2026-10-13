"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Zap } from "lucide-react";
import { InboxHelp } from "@/components/hire/inbox-help";

interface OnboardingPanelProps {
  deploymentId: string;
  /** Email-only hires mail from the platform's domain, which spam filters may catch. */
  emailOnly?: boolean;
}

export function OnboardingPanel({ deploymentId, emailOnly = false }: OnboardingPanelProps) {
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    setActivating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/deployments/${deploymentId}/onboarding/advance`,
        { method: "POST" },
      );
      if (res.ok) {
        // Reload the page so the dashboard switches to the active view
        window.location.reload();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    }
    setActivating(false);
  };

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <h3 className="text-lg font-semibold">Your agent is ready to start</h3>
        <p className="text-sm text-muted-foreground">
          Its mailbox is set up, but it isn&apos;t running yet — nothing reads or
          answers your email until you activate it. Activating starts it (usually
          under a minute), then it emails you an introduction and works under your
          approval policy from then on.
        </p>
        {emailOnly && <InboxHelp />}
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <Button onClick={handleActivate} disabled={activating}>
          {activating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Zap className="mr-2 h-4 w-4" />
          )}
          {activating ? "Starting your agent…" : "Activate Agent"}
        </Button>
      </CardContent>
    </Card>
  );
}
