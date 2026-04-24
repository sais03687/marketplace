"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

function BillingSuccessContent() {
  const searchParams = useSearchParams();
  const [deploymentStatus, setDeploymentStatus] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const deploymentId =
    searchParams.get("deploymentId") ||
    (typeof window !== "undefined" ? localStorage.getItem("pendingDeploymentId") : null);

  useEffect(() => {
    if (!deploymentId) {
      setReady(true);
      return;
    }

    // Poll until deployment moves past PROVISIONING
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/deployments/${deploymentId}`);
        if (res.ok) {
          const data = await res.json();
          setDeploymentStatus(data.status);
          if (data.status === "ONBOARDING" || data.status === "ACTIVE") {
            clearInterval(interval);
            setReady(true);
            localStorage.removeItem("pendingDeploymentId");
          } else if (data.status === "ERROR") {
            clearInterval(interval);
            setReady(true);
          }
        }
      } catch {
        // Continue polling
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [deploymentId]);

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <CheckCircle2 className="h-14 w-14 text-emerald-500" />
      <h1 className="mt-6 text-2xl font-bold">Payment confirmed!</h1>
      <p className="mt-2 text-muted-foreground max-w-sm">
        Your AI employee is being set up. Head to the dashboard to send their
        introduction email and mark them live — usually ready within a few minutes.
      </p>

      {deploymentId && !ready && (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>
            Setting up workspace
            {deploymentStatus ? ` (${deploymentStatus.toLowerCase()})` : "..."}
          </span>
        </div>
      )}

      <div className="mt-8 flex gap-3">
        <Button asChild>
          <Link href="/dashboard">Go to Dashboard</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/dashboard/billing">View Billing</Link>
        </Button>
      </div>
    </div>
  );
}

export default function BillingSuccessPage() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <CheckCircle2 className="h-14 w-14 text-emerald-500" />
        <h1 className="mt-6 text-2xl font-bold">Payment confirmed!</h1>
        <Loader2 className="mt-6 h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <BillingSuccessContent />
    </Suspense>
  );
}
