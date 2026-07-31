"use client";

import { useEffect, useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useHire } from "@/lib/hire-context";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Info, CheckCircle2, XCircle, ExternalLink } from "lucide-react";

// Microsoft 365 is the only workspace an agent can be provisioned into. Google was
// removed entirely, and "Neither" depended on AgentMail, which is no longer an agent
// mail channel — an agent needs an M365 mailbox to send or receive anything at all.
const WORKSPACE_OPTIONS: Array<{
  value: "MICROSOFT";
  label: string;
  desc: string;
}> = [
  { value: "MICROSOFT", label: "Microsoft 365", desc: "Outlook Calendar, OneDrive, Excel, Word" },
];

type Licensing = {
  selected: { skuPartNumber: string; displayName: string; seatsFree: number } | null;
  exhausted: Array<{ displayName: string; seatsUsed: number; seatsTotal: number }>;
  capabilities: {
    email: boolean;
    calendar: boolean;
    sharepoint: boolean;
    onedrive: boolean;
    teams: boolean;
  };
};

/**
 * Shows which licence the agent will consume and what it will be able to do.
 *
 * Buyers were previously given no visibility here at all: a hire could quietly consume a
 * seat, or fail outright because no licence had one free, with nothing on screen to
 * explain either. Showing it before the money is spent turns a support ticket into a
 * decision the buyer makes knowingly.
 */
function LicensingSummary({ tenantId, agentName }: { tenantId: string | null; agentName: string }) {
  const [data, setData] = useState<Licensing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/microsoft/licensing?tenantId=${encodeURIComponent(tenantId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) setError(body.error ?? "We couldn't check your Microsoft 365 licences.");
        else setData(body);
      })
      .catch(() => !cancelled && setError("We couldn't check your Microsoft 365 licences."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (loading) {
    return (
      <div className="rounded-lg border p-3 text-xs text-muted-foreground">
        Checking which licence {agentName || "your agent"} will use…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        {error} You can still continue — we&apos;ll check again during setup.
      </div>
    );
  }

  if (!data) return null;

  const caps: Array<[string, boolean, string]> = [
    ["Send and receive email", data.capabilities.email, "Its own mailbox on your domain"],
    ["Outlook calendar", data.capabilities.calendar, "Read and manage events"],
    ["SharePoint files", data.capabilities.sharepoint, "Read and edit shared files and Excel workbooks"],
    ["Its own OneDrive", data.capabilities.onedrive, "Personal file storage for the agent"],
    ["Microsoft Teams", data.capabilities.teams, "Direct messages and approvals in Teams"],
  ];

  // No seat anywhere: the hire will fail, so say so before payment rather than after.
  if (!data.selected) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 space-y-2">
        <p className="font-medium">No Microsoft 365 licence seat available</p>
        <p>
          Your agent needs a licence that includes Exchange Online so it can have a mailbox.
          {data.exhausted.length > 0 ? (
            <>
              {" "}
              These are full:{" "}
              {data.exhausted
                .map((s) => `${s.displayName} (${s.seatsUsed}/${s.seatsTotal} used)`)
                .join(", ")}
              .
            </>
          ) : (
            " Your organization doesn't have one yet."
          )}
        </p>
        <p>
          Add a seat in the Microsoft 365 admin center — Business Basic is the cheapest that
          works — then come back. Free licences such as Power Automate Free can&apos;t be used,
          because they don&apos;t include a mailbox.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium">Licence {agentName || "your agent"} will use</p>
        <span className="text-[10px] text-muted-foreground">
          {data.selected.seatsFree} seat{data.selected.seatsFree === 1 ? "" : "s"} free
        </span>
      </div>
      <p className="text-sm font-medium">{data.selected.displayName}</p>

      <ul className="space-y-1">
        {caps.map(([label, enabled, desc]) => (
          <li key={label} className="flex items-start gap-2 text-xs">
            {enabled ? (
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-green-600" />
            ) : (
              <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className={enabled ? "" : "text-muted-foreground"}>
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground"> — {desc}</span>
              {!enabled && <span className="text-muted-foreground"> (not in this licence)</span>}
            </span>
          </li>
        ))}
      </ul>

      <p className="text-[10px] text-muted-foreground">
        One seat is used while your agent is set up. SharePoint access comes from the
        Marketplace app rather than this licence, so it works on any plan.
      </p>
    </div>
  );
}

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
        mailboxLocation: "buyer_org",
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
                {state.hireName} will operate entirely within your organization{"'"}s
                Microsoft 365 — SharePoint files, Outlook calendar, and a shared
                mailbox on your domain (e.g.{" "}
                <span className="font-mono">{state.agentSlug}@yourcompany.com</span>
                ). All data stays in your tenant.
              </p>
            </div>
          </div>
        </div>
      )}

      {state.workspaceProvider === "MICROSOFT" && msConnected && (
        <LicensingSummary tenantId={state.buyerMicrosoftTenantId} agentName={state.hireName} />
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
