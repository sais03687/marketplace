"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHire } from "@/lib/hire-context";
import { Mail } from "lucide-react";

export function StepName() {
  const { state, updateState, setStep } = useHire();

  const emailPreview = `${state.hireName.toLowerCase().replace(/\s+/g, ".")}@agentmail.to`;

  return (
    <div className="space-y-6">
      <div>
        <label className="text-sm font-medium">Agent Name</label>
        <Input
          className="mt-1"
          value={state.hireName}
          onChange={(e) => updateState({ hireName: e.target.value })}
          placeholder="e.g. Alex"
        />
      </div>

      <div>
        <label className="text-sm font-medium">Role Title</label>
        <Input
          className="mt-1"
          value={state.roleTitle}
          onChange={(e) => updateState({ roleTitle: e.target.value })}
          placeholder="e.g. Operations Assistant"
        />
      </div>

      <div className="rounded-lg bg-muted p-3">
        <div className="flex items-center gap-2 text-sm">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Email address:</span>
          <span className="font-mono text-xs">{emailPreview}</span>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setStep(1)}>
          Back
        </Button>
        <Button
          className="flex-1"
          onClick={() => setStep(3)}
          disabled={!state.hireName.trim()}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
