"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHire } from "@/lib/hire-context";
import { WorksWithPicker, type WorksWithOption } from "@/components/dashboard/works-with-picker";

export function StepNotifications() {
  const { state, updateState, setStep } = useHire();
  // The buyer's other hires, for "which should it work with?". Null while loading;
  // a buyer with none (or signed out) simply doesn't see the question.
  const [others, setOthers] = useState<WorksWithOption[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/deployments")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Array<{ id: string; agentName: string; status: string; agent?: { name?: string } }>) => {
        if (cancelled) return;
        setOthers(
          (Array.isArray(list) ? list : [])
            .filter((d) => !["FIRED", "PENDING_PAYMENT", "ERROR"].includes(d.status))
            .map((d) => ({ id: d.id, name: d.agentName, agent: d.agent?.name ?? "", status: d.status })),
        );
      })
      .catch(() => !cancelled && setOthers([]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Set up who receives approval requests and reports.
      </p>

      <div>
        <label className="text-sm font-medium">Manager Email</label>
        <p className="text-xs text-muted-foreground mb-1">
          Receives approval requests and agent updates. This address can always
          email the agent, even before you add anyone to its allowlist.
        </p>
        <Input
          type="email"
          value={state.managerEmail}
          onChange={(e) => updateState({ managerEmail: e.target.value })}
          placeholder="manager@company.com"
        />
      </div>

      {others && others.length > 0 && (
        <div>
          <label className="text-sm font-medium">Which of your agents should it work with?</label>
          <p className="text-xs text-muted-foreground mb-2">
            The agents you tick are told about {state.hireName || "this agent"} and can hand work to
            each other by email. The rest never hear of it. You can change this later in Settings.
          </p>
          <WorksWithPicker
            options={others}
            selected={state.worksWith ?? []}
            onChange={(next) => updateState({ worksWith: next })}
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setStep(3)}>
          Back
        </Button>
        <Button className="flex-1" onClick={() => setStep(5)}>
          Continue
        </Button>
      </div>
    </div>
  );
}
