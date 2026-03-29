"use client";

import { useUser, useOrganization, SignIn, CreateOrganization } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Building2, Check } from "lucide-react";

export function StepAccount() {
  const { setStep } = useHire();
  const { isSignedIn, user } = useUser();
  const { organization } = useOrganization();

  if (!isSignedIn) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Sign in to continue hiring.
        </p>
        <SignIn routing="hash" />
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Create or select an organization to manage your AI employees.
        </p>
        <CreateOrganization routing="hash" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-medium">{organization.name}</p>
            <p className="text-xs text-muted-foreground">
              Signed in as {user?.primaryEmailAddress?.emailAddress}
            </p>
          </div>
          <Check className="ml-auto h-5 w-5 text-emerald-500" />
        </div>
      </div>

      <Button className="w-full" onClick={() => setStep(2)}>
        Continue as {organization.name}
      </Button>
    </div>
  );
}
