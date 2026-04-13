"use client";

import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Calendar, HardDrive, Info } from "lucide-react";

export function StepConnect() {
  const { state, setStep } = useHire();

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
          <Badge variant="success">Auto-configured</Badge>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-dashed p-4">
          <div className="flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-[#0F9D58]" />
            <div>
              <p className="font-medium text-sm">Google Drive / Sheets / Docs</p>
              <p className="text-xs text-muted-foreground">
                Share files with your agent&apos;s Google identity after hiring.
              </p>
            </div>
          </div>
          <Badge variant="success">Auto-configured</Badge>
        </div>
      </div>

      <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <div>
            <p className="font-medium mb-1">How integrations work</p>
            <p>
              Google Calendar and Drive are connected automatically during setup.
              Your agent will share its Google service account email in its
              introduction — share files with that address like you would with a
              colleague. Slack integration is coming soon.
            </p>
          </div>
        </div>
      </div>

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
