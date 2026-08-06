"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { VolumeX, Volume2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Stop this agent using one shared lesson.
 *
 * AgentMind is shared across every deployment of an agent, so a lesson written
 * by another company's agent can reach yours. Deleting it is not yours to do —
 * it belongs to whoever wrote it — but silencing it for your own agent is.
 */
export function MuteContributionButton({
  deploymentId,
  contributionId,
  muted,
}: {
  deploymentId: string;
  contributionId: string;
  muted: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const toggle = async () => {
    setBusy(true);
    try {
      await fetch("/api/agentmind/mute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deploymentId, contributionId, muted: !muted }),
      });
      router.refresh();
    } catch {
      // Non-fatal: the row stays as it was and the buyer can try again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      disabled={busy}
      title={
        muted
          ? "Let your agent use this shared lesson again"
          : "Stop your agent using this shared lesson. Other companies are unaffected."
      }
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : muted ? (
        <Volume2 className="h-3.5 w-3.5" />
      ) : (
        <VolumeX className="h-3.5 w-3.5" />
      )}
      <span className="ml-1.5">{muted ? "Unmute" : "Mute"}</span>
    </Button>
  );
}
