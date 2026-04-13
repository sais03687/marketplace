"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OnboardingProgress } from "@/components/marketplace/onboarding-progress";
import { OnboardingInterview } from "./onboarding-interview";
import { Loader2, ArrowRight, Check } from "lucide-react";

interface OnboardingPanelProps {
  deploymentId: string;
}

interface OnboardingData {
  onboardingState: string;
  onboardingData: Record<string, string> | null;
  questions: Array<{
    id: string;
    order: number;
    question: string;
    memoryKey: string;
    required: boolean;
    followUp?: string;
    type?: "text" | "choice";
    options?: Array<{ value: string; label: string }>;
    default?: string;
  }>;
  status: string;
}

export function OnboardingPanel({ deploymentId }: OnboardingPanelProps) {
  const [data, setData] = useState<OnboardingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [advancing, setAdvancing] = useState(false);

  const fetchData = async () => {
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/onboarding`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // retry silently
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [deploymentId]);

  const handleAdvance = async () => {
    setAdvancing(true);
    try {
      const res = await fetch(
        `/api/deployments/${deploymentId}/onboarding/advance`,
        { method: "POST" },
      );
      if (res.ok) {
        await fetchData();
      }
    } catch {
      // retry silently
    }
    setAdvancing(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <p className="text-sm text-muted-foreground">
        Failed to load onboarding data.
      </p>
    );
  }

  const { onboardingState, questions } = data;

  return (
    <div className="space-y-6">
      <OnboardingProgress currentStage={onboardingState} />

      {onboardingState === "INTERVIEW" && (
        <OnboardingInterview
          deploymentId={deploymentId}
          questions={questions}
          onComplete={fetchData}
        />
      )}

      {onboardingState === "OBSERVATION" && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="text-lg font-semibold">Observation Period</h3>
            <p className="text-sm text-muted-foreground">
              Your agent is learning from the onboarding answers and observing
              how things work. When you feel the agent is ready, click the
              button below to move to the introduction phase.
            </p>
            <Button onClick={handleAdvance} disabled={advancing}>
              {advancing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="mr-2 h-4 w-4" />
              )}
              Confirm Ready
            </Button>
          </CardContent>
        </Card>
      )}

      {onboardingState === "INTRODUCTION" && (
        <Card>
          <CardContent className="p-6 space-y-4">
            <h3 className="text-lg font-semibold">Introduction</h3>
            <p className="text-sm text-muted-foreground">
              Your agent is sending introduction emails to key team members.
              Once the introductions are complete, mark the agent as live to
              begin full operation.
            </p>
            <Button onClick={handleAdvance} disabled={advancing}>
              {advancing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              Mark as Live
            </Button>
          </CardContent>
        </Card>
      )}

      {onboardingState === "LIVE" && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-2">
              <Check className="h-5 w-5 text-emerald-500" />
              <h3 className="text-lg font-semibold">Onboarding Complete</h3>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Your agent is now fully onboarded and operating. Check the
              dashboard for activity and approvals.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
