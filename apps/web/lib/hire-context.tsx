"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

export interface HireState {
  agentId: string;
  agentName: string;
  agentSlug: string;
  // Step 2
  hireName: string;
  roleTitle: string;
  // Step 3
  slackConnected: boolean;
  workspaceProvider: "GOOGLE" | "MICROSOFT" | "NONE";
  // Step 4
  approvalManagerEmail: string;
  weeklyDigestEmail: string;
  // Step 5 — interview answers collected during hire
  onboardingAnswers: Record<string, string>;
  // Step 6
  deploymentId: string | null;
  deploymentStatus: string | null;
}

interface HireContextType {
  step: number;
  setStep: (step: number) => void;
  state: HireState;
  updateState: (partial: Partial<HireState>) => void;
}

const HireContext = createContext<HireContextType | null>(null);

export function HireProvider({
  children,
  agentId,
  agentName,
  agentSlug,
}: {
  children: ReactNode;
  agentId: string;
  agentName: string;
  agentSlug: string;
}) {
  const [step, setStep] = useState(1);
  const [state, setState] = useState<HireState>({
    agentId,
    agentName,
    agentSlug,
    hireName: agentName.split("—")[0].trim(),
    roleTitle: "AI Operations Assistant",
    slackConnected: false,
    workspaceProvider: "NONE",
    approvalManagerEmail: "",
    weeklyDigestEmail: "",
    onboardingAnswers: {},
    deploymentId: null,
    deploymentStatus: null,
  });

  const updateState = (partial: Partial<HireState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  };

  return (
    <HireContext.Provider value={{ step, setStep, state, updateState }}>
      {children}
    </HireContext.Provider>
  );
}

export function useHire() {
  const ctx = useContext(HireContext);
  if (!ctx) throw new Error("useHire must be used within HireProvider");
  return ctx;
}
