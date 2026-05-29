"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";

export function StepConfirmation() {
  const { state, updateState, setStep } = useHire();
  const [status, setStatus] = useState<
    "review" | "deploying" | "success" | "error"
  >("review");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleDeploy = async () => {
    setStatus("deploying");
    setError("");

    try {
      const res = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: state.agentId,
          agentName: state.hireName,
          roleTitle: state.roleTitle,
          weeklyDigestEmail: state.weeklyDigestEmail || undefined,
          approvalManagerEmail: state.approvalManagerEmail || undefined,
          workspaceProvider: state.workspaceProvider,
          onboardingAnswers: Object.keys(state.onboardingAnswers).length > 0
            ? state.onboardingAnswers
            : undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create deployment");
      }

      const data = await res.json();
      updateState({ deploymentId: data.deploymentId });

      if (data.checkoutUrl) {
        // Store deploymentId so success page can reference it
        localStorage.setItem("pendingDeploymentId", data.deploymentId);
        window.location.href = data.checkoutUrl;
        return;
      }

      // Dev/no-Stripe fallback: poll for status directly
      const dep = data.deployment ?? data;
      updateState({ deploymentStatus: dep.status });

      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/deployments/${data.deploymentId}`);
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            updateState({ deploymentStatus: pollData.status });
            if (pollData.status === "ONBOARDING" || pollData.status === "ACTIVE") {
              setStatus("success");
              if (pollRef.current) clearInterval(pollRef.current);
            } else if (pollData.status === "ERROR") {
              setStatus("error");
              setError("Provisioning failed. Our team has been notified.");
              if (pollRef.current) clearInterval(pollRef.current);
            }
          }
        } catch {
          // Continue polling
        }
      }, 3000);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  };

  if (status === "deploying") {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="mt-4 font-medium">Preparing checkout...</p>
        <p className="mt-1 text-sm text-muted-foreground">
          You&apos;ll be redirected to Stripe to complete your subscription.
        </p>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="mt-4 text-lg font-semibold">
          {state.hireName} is ready!
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your AI employee is being set up with your preferences and will
          introduce themselves via email once ready.
        </p>
        <Button className="mt-6" asChild>
          <Link href="/dashboard">Go to Your Portal</Link>
        </Button>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <XCircle className="h-12 w-12 text-destructive" />
        <p className="mt-4 text-lg font-semibold">Something went wrong</p>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <div className="mt-6 flex gap-2">
          <Button variant="outline" onClick={() => setStep(5)}>
            Back
          </Button>
          <Button onClick={handleDeploy}>Try Again</Button>
        </div>
      </div>
    );
  }

  // Review state
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Agent</span>
          <span className="font-medium">{state.agentName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Name</span>
          <span className="font-medium">{state.hireName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Role</span>
          <span className="font-medium">{state.roleTitle}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Slack</span>
          <span>{state.slackConnected ? "Connected" : "Not connected"}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Workspace</span>
          <span>
            {state.workspaceProvider === "GOOGLE"
              ? "Google Workspace"
              : state.workspaceProvider === "MICROSOFT"
              ? "Microsoft 365"
              : "None"}
          </span>
        </div>
        {state.approvalManagerEmail && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Approvals</span>
            <span className="font-mono text-xs">
              {state.approvalManagerEmail}
            </span>
          </div>
        )}
      </div>

      <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        Your setup answers have been saved. All actions requiring approval
        will be queued until you review and approve them.
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setStep(5)}>
          Back
        </Button>
        <Button className="flex-1" onClick={handleDeploy}>
          Hire {state.hireName} — Pay with Stripe
        </Button>
      </div>
    </div>
  );
}
