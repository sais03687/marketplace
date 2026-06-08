"use client";

import { useEffect, useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Info, CheckCircle2, ExternalLink } from "lucide-react";

const WORKSPACE_OPTIONS: Array<{
  value: "GOOGLE" | "MICROSOFT" | "NONE";
  label: string;
  desc: string;
}> = [
  { value: "GOOGLE", label: "Google Workspace", desc: "Calendar, Drive, Docs, Sheets" },
  { value: "MICROSOFT", label: "Microsoft 365", desc: "Outlook Calendar, OneDrive, Excel, Word" },
  { value: "NONE", label: "Neither", desc: "Email only via Agentmail" },
];

export function StepConnect() {
  const { state, updateState, setStep } = useHire();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [msConnected, setMsConnected] = useState(!!state.buyerMicrosoftTenantId);

  // After OAuth callback, read microsoftTenantId from URL and store in hire state
  useEffect(() => {
    const tenantId = searchParams.get("microsoftTenantId");
    const msStatus = searchParams.get("microsoft");
    if (tenantId && msStatus === "connected") {
      updateState({
        buyerMicrosoftTenantId: tenantId,
        workspaceProvider: "MICROSOFT",
      });
      setMsConnected(true);
      // Clean the URL params without navigation
      window.history.replaceState({}, "", pathname);
    }
  }, [searchParams, pathname, updateState]);

  // Sync local state with hire state
  useEffect(() => {
    setMsConnected(!!state.buyerMicrosoftTenantId);
  }, [state.buyerMicrosoftTenantId]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Your agent will use these integrations when available. All are
        pre-configured server-side during provisioning.
      </p>

      <div className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <MessageSquare className="h-5 w-5 text-[#4A154B]" />
            <div>
              <p className="font-medium text-sm">Slack</p>
              <p className="text-xs text-muted-foreground">
                Notifications and approvals
              </p>
            </div>
          </div>
          <Badge variant="secondary">Coming soon</Badge>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Workspace</p>
          <p className="text-xs text-muted-foreground">
            Give {state.hireName} access to your organization{"'"}s calendar and
            files. One-click connection — no technical setup required.
          </p>
          {WORKSPACE_OPTIONS.map(({ value, label, desc }) => (
            <label
              key={value}
              className={`flex items-center gap-3 cursor-pointer rounded-lg border p-4 transition-colors hover:border-primary/50 ${
                state.workspaceProvider === value
                  ? "border-primary bg-primary/5"
                  : ""
              }`}
            >
              <input
                type="radio"
                name="workspaceProvider"
                value={value}
                checked={state.workspaceProvider === value}
                onChange={() => {
                  updateState({ workspaceProvider: value });
                  // Clear tenantId if switching away from Microsoft
                  if (value !== "MICROSOFT") {
                    updateState({ buyerMicrosoftTenantId: null });
                  }
                }}
                className="shrink-0"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{label}</p>
                  {value === "MICROSOFT" && msConnected && (
                    <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 text-[10px] px-1.5 py-0">
                      <CheckCircle2 className="h-3 w-3 mr-0.5" />
                      Connected
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {state.workspaceProvider === "MICROSOFT" && !msConnected && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
          <div className="flex items-start gap-2 text-xs text-blue-800">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <div>
              <p className="font-medium mb-1">Connect your Microsoft 365</p>
              <p>
                Click below to authorize {state.hireName} to access your
                organization{"'"}s SharePoint files and Outlook calendars. You{"'"}ll
                sign in as your Microsoft 365 admin and approve the connection.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              const returnTo = encodeURIComponent(pathname);
              window.location.href = `/api/microsoft/connect?returnTo=${returnTo}`;
            }}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Connect Microsoft 365
          </Button>
        </div>
      )}

      {state.workspaceProvider === "MICROSOFT" && msConnected && (
        <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-xs text-green-800">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
            <div>
              <p className="font-medium mb-1">Microsoft 365 connected</p>
              <p>
                {state.hireName} will have access to your organization{"'"}s
                SharePoint files and Outlook calendars.
              </p>
            </div>
          </div>
        </div>
      )}

      {state.workspaceProvider === "GOOGLE" && (
        <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <div>
              <p className="font-medium mb-1">How Google Workspace works</p>
              <p>
                {state.hireName} will get their own Google account with
                Calendar, Drive, Docs, and Sheets. Share files and send
                calendar invites to their workspace address like you would
                with any colleague. Set up fully automatically — no admin
                steps required.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setStep(2)}>
          Back
        </Button>
        <Button className="flex-1" onClick={() => setStep(4)}>
          Continue
        </Button>
      </div>
    </div>
  );
}
