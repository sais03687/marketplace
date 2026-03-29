"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHire } from "@/lib/hire-context";

export function StepNotifications() {
  const { state, updateState, setStep } = useHire();

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Set up who receives approval requests and reports.
      </p>

      <div>
        <label className="text-sm font-medium">Approval Manager Email</label>
        <p className="text-xs text-muted-foreground mb-1">
          This person will receive approval requests from your AI employee.
        </p>
        <Input
          type="email"
          value={state.approvalManagerEmail}
          onChange={(e) =>
            updateState({ approvalManagerEmail: e.target.value })
          }
          placeholder="manager@company.com"
        />
      </div>

      <div>
        <label className="text-sm font-medium">Weekly Digest Email</label>
        <p className="text-xs text-muted-foreground mb-1">
          Receive a weekly summary of tasks, approvals, and trust score
          progress.
        </p>
        <Input
          type="email"
          value={state.weeklyDigestEmail}
          onChange={(e) => updateState({ weeklyDigestEmail: e.target.value })}
          placeholder="team@company.com"
        />
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setStep(3)}>
          Back
        </Button>
        <Button className="flex-1" onClick={() => setStep(5)}>
          Review & Hire
        </Button>
      </div>
    </div>
  );
}
