"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { HireModal } from "./hire-modal";

interface HireButtonProps {
  agentId: string;
  agentName: string;
  agentSlug: string;
  label?: string;
}

export function HireButton({ agentId, agentName, agentSlug, label }: HireButtonProps) {
  const searchParams = useSearchParams();
  // Auto-open modal when returning from Microsoft OAuth callback
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (searchParams.get("microsoft") === "connected" && searchParams.get("microsoftTenantId")) {
      setOpen(true);
    }
  }, [searchParams]);

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
