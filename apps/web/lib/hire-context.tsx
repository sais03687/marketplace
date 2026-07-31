"use client";

import {
  createContext,
  useContext,
  useEffect,
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
  workspaceProvider: "MICROSOFT";
  buyerMicrosoftTenantId: string | null;
  mailboxLocation: "platform" | "buyer_org";
  // Step 4
  managerEmail: string;
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
  const STORAGE_KEY = `hire-state-${agentSlug}`;

  // Restore state from sessionStorage if returning from OAuth redirect
  const [step, setStepRaw] = useState(() => {
    if (typeof window === "undefined") return 1;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved).step || 1;
    } catch {}
    return 1;
  });

  const [state, setState] = useState<HireState>(() => {
    const defaults: HireState = {
      agentId,
      agentName,
      agentSlug,
      hireName: agentName.split("—")[0].trim(),
      roleTitle: "AI Operations Assistant",
      slackConnected: false,
      workspaceProvider: "MICROSOFT",
      buyerMicrosoftTenantId: null,
      mailboxLocation: "buyer_org",
      managerEmail: "",
      onboardingAnswers: {},
      deploymentId: null,
      deploymentStatus: null,
    };
    if (typeof window === "undefined") return defaults;
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...defaults, ...parsed.state };
      }
    } catch {}
    return defaults;
  });

  // Persist to sessionStorage on every change (survives OAuth redirects)
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, state }));
    } catch {}
  }, [step, state, STORAGE_KEY]);

  const setStep = (s: number) => {
    setStepRaw(s);
  };

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
