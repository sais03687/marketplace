"use client";

import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Calendar, Check, AlertTriangle, HardDrive } from "lucide-react";

export function StepConnect() {
  const { state, updateState, setStep } = useHire();

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Connect the tools your AI employee needs to work. You can skip and
        connect later.
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
          {state.slackConnected ? (
            <Badge variant="success">
              <Check className="mr-1 h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateState({ slackConnected: true })}
            >
              Connect
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <Calendar className="h-5 w-5 text-[#4285f4]" />
            <div>
              <p className="font-medium text-sm">Google Calendar</p>
              <p className="text-xs text-muted-foreground">
                Meeting prep and scheduling
              </p>
            </div>
          </div>
          {state.googleCalendarConnected ? (
            <Badge variant="success">
              <Check className="mr-1 h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateState({ googleCalendarConnected: true })}
            >
              Connect
            </Button>
          )}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-dashed p-4">
          <div className="flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-[#0F9D58]" />
            <div>
              <p className="font-medium text-sm">Google Drive / Sheets / Docs</p>
              <p className="text-xs text-muted-foreground">
                Pre-connected. Share files with your agent&apos;s Google identity after hiring.
              </p>
            </div>
          </div>
          <Badge variant="secondary">Auto</Badge>
        </div>
      </div>

      <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
        <p className="font-medium mb-1">How file sharing works</p>
        <p>
          Your agent has two addresses: an <strong>email address</strong> for communication,
          and a <strong>Google service account</strong> for file access. After hiring, share
          any Google Drive file with the agent&apos;s service account email — just like sharing
          with a colleague. The agent will tell you the address in its intro email.
        </p>
      </div>

      {(!state.slackConnected || !state.googleCalendarConnected) && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <p>
            Some features may be limited without these integrations. You can
            connect them later from your dashboard.
          </p>
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
