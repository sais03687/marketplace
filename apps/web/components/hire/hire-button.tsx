"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HireModal } from "./hire-modal";

interface HireButtonProps {
  agentId: string;
  agentName: string;
  agentSlug: string;
  label?: string;
}

export function HireButton({ agentId, agentName, agentSlug, label }: HireButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button className="w-full" size="lg" onClick={() => setOpen(true)}>
        {label ?? `Hire ${agentName}`}
      </Button>
      <HireModal
        open={open}
        onOpenChange={setOpen}
        agentId={agentId}
        agentName={agentName}
        agentSlug={agentSlug}
      />
    </>
  );
}
