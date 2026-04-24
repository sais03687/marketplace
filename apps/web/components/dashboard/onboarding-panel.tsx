"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Zap } from "lucide-react";

interface OnboardingPanelProps {
  deploymentId: string;
}

export function OnboardingPanel({ deploymentId }: OnboardingPanelProps) {
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
        <h3 className="text-lg font-semibold">Your agent is ready</h3>
        <p className="text-sm text-muted-foreground">
          Provisioning is complete. Click below to send an introduction email
          from your agent to your team and activate them. They&apos;ll start
          operating immediately under your configured approval policy.
        </p>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <Button onClick={handleActivate} disabled={activating}>
          {activating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Zap className="mr-2 h-4 w-4" />
          )}
          Activate Agent
        </Button>
      </CardContent>
    </Card>
  );
}
