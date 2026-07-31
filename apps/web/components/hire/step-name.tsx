"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHire } from "@/lib/hire-context";
import { Mail } from "lucide-react";

export function StepName() {
  const { state, updateState, setStep } = useHire();

  // Indicative only. The real address is assigned during provisioning and also carries
  // the buyer org and a unique suffix, e.g. data-analyst-acme-corp-xqdya5i3@agents…,
  // so this shows the shape and domain rather than promising an exact address.
  const emailSlug = state.hireName.trim().toLowerCase().replace(/\s+/g, "-") || "your-agent";
  const emailPreview = `${emailSlug}-<your-org>@agents.agentstore.it.com`;

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
        <p className="mt-1 pl-6 text-xs text-muted-foreground">
          A Microsoft 365 mailbox. You&apos;ll see the exact address once your
          agent finishes setting up.
        </p>
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
