"use client";

import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Info } from "lucide-react";

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
            Give {state.hireName} their own calendar and file access as a member
            of your team. Provisioned automatically — no setup required.
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
                onChange={() => updateState({ workspaceProvider: value })}
                className="shrink-0"
              />
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {state.workspaceProvider !== "NONE" && (
        <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <div>
              <p className="font-medium mb-1">
                How{" "}
                {state.workspaceProvider === "GOOGLE"
                  ? "Google Workspace"
                  : "Microsoft 365"}{" "}
                works
              </p>
              <p>
                {state.hireName} will get their own{" "}
                {state.workspaceProvider === "GOOGLE"
                  ? "Google account with Calendar, Drive, Docs, and Sheets"
                  : "Microsoft 365 account with Outlook Calendar, OneDrive, Excel, and Word"}
                . Share files and send calendar invites to their workspace
                address like you would with any colleague. Set up fully
                automatically — no admin steps required.
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
