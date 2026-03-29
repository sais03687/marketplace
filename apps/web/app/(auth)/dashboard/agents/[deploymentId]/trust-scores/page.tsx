"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { TrustScoreBar } from "@/components/marketplace/trust-score-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface TrustScore {
  id: string;
  taskType: string;
  approvedNoEdit: number;
  edited: number;
  rejected: number;
  weightedScore: number;
  autonomyLevel: string;
  lastUpdated: string;
}

const AUTONOMY_OPTIONS = [
  { value: "always_queue", label: "Always Queue" },
  { value: "queue_if_stakes_gt_5", label: "Queue if Stakes > 5" },
  { value: "queue_if_stakes_gt_7", label: "Queue if Stakes > 7" },
  { value: "auto_execute", label: "Auto Execute" },
];

export default function TrustScoresPage() {
  const params = useParams();
  const deploymentId = params.deploymentId as string;
  const [scores, setScores] = useState<TrustScore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}/trust-scores`)
      .then((r) => r.json())
      .then((data) => {
        setScores(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [deploymentId]);

  const handleOverride = async (taskType: string, autonomyLevel: string) => {
    await fetch(`/api/deployments/${deploymentId}/trust-scores`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskType, autonomyLevel }),
    });

    // Refresh
    const res = await fetch(`/api/deployments/${deploymentId}/trust-scores`);
    const data = await res.json();
    setScores(Array.isArray(data) ? data : []);
  };

  if (loading) {
    return <div className="text-muted-foreground">Loading trust scores...</div>;
  }

  if (scores.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-lg font-medium">No trust data yet</p>
        <p className="mt-1 text-muted-foreground">
          Trust scores will appear after your AI employee submits actions for
          approval.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Trust Scores</h2>
        <p className="text-sm text-muted-foreground">
          Trust is calculated per task type based on approval history.
        </p>
      </div>

      <div className="space-y-4">
        {scores.map((score) => {
          const total =
            score.approvedNoEdit + score.edited + score.rejected;

          return (
            <Card key={score.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{score.taskType}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <TrustScoreBar
                  score={score.weightedScore}
                  autonomyLevel={score.autonomyLevel}
                />
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>Total: {total}</span>
                  <span>Approved: {score.approvedNoEdit}</span>
                  <span>Edited: {score.edited}</span>
                  <span>Rejected: {score.rejected}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Override:
                  </span>
                  <select
                    value={score.autonomyLevel}
                    onChange={(e) =>
                      handleOverride(score.taskType, e.target.value)
                    }
                    className="h-8 rounded border border-input bg-background px-2 text-xs"
                  >
                    {AUTONOMY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
