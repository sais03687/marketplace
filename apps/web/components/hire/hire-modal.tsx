"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HireProvider, useHire } from "@/lib/hire-context";
import { StepAccount } from "./step-account";
import { StepName } from "./step-name";
import { StepConnect } from "./step-connect";
import { StepNotifications } from "./step-notifications";
import { StepConfirmation } from "./step-confirmation";
import { cn } from "@/lib/utils";

const STEPS = [
  { label: "Account", component: StepAccount },
  { label: "Name", component: StepName },
  { label: "Connect", component: StepConnect },
  { label: "Notifications", component: StepNotifications },
  { label: "Confirm", component: StepConfirmation },
];

function HireModalContent() {
  const { step } = useHire();
  const StepComponent = STEPS[step - 1].component;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Hire AI Employee</DialogTitle>
      </DialogHeader>

      {/* Progress bar */}
      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => (
          <div key={s.label} className="flex-1">
            <div
              className={cn(
                "h-1 rounded-full transition-colors",
                i < step ? "bg-primary" : "bg-muted",
              )}
            />
            <p
              className={cn(
                "mt-1 text-center text-[10px]",
                i + 1 === step
                  ? "font-medium text-primary"
                  : "text-muted-foreground",
              )}
            >
              {s.label}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 min-h-[280px]">
        <StepComponent />
      </div>
    </>
  );
}

interface HireModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  agentName: string;
  agentSlug: string;
}

export function HireModal({
  open,
  onOpenChange,
  agentId,
  agentName,
  agentSlug,
}: HireModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <HireProvider
          agentId={agentId}
          agentName={agentName}
          agentSlug={agentSlug}
        >
          <HireModalContent />
        </HireProvider>
      </DialogContent>
    </Dialog>
  );
}
