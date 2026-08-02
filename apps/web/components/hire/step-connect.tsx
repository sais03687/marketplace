"use client";

import { useEffect, useState, useCallback } from "react";
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
  /**
   * Every mailbox-capable licence with a seat free, cheapest-adequate first.
   * The API has always returned this and the UI used to discard it, so a buyer
   * holding both Business Basic and E3 was shown one name with no indication
   * that a choice had been made on their behalf, or that they could influence it.
   */
  usable: Array<{ skuPartNumber: string; displayName: string; seatsFree: number }>;
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
 * What the licence check means for whether the buyer may proceed.
 *
 * "error" is deliberately not blocking: that is us failing to read their tenant, not
 * them lacking a seat, and provisioning re-checks anyway. Refusing the sale because
 * our own call failed would be the wrong way round.
 */
type LicensingStatus = "loading" | "ok" | "no-seat" | "error";

/**
 * Shows which licence the agent will consume and what it will be able to do.
 *
 * Buyers were previously given no visibility here at all: a hire could quietly consume a
 * seat, or fail outright because no licence had one free, with nothing on screen to
 * explain either. Showing it before the money is spent turns a support ticket into a
 * decision the buyer makes knowingly.
 */
function LicensingSummary({
  tenantId,
  agentName,
  onStatusChange,
}: {
  tenantId: string | null;
  agentName: string;
  onStatusChange: (status: LicensingStatus) => void;
}) {
  const [data, setData] = useState<Licensing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    onStatusChange("loading");
    fetch(`/api/microsoft/licensing?tenantId=${encodeURIComponent(tenantId)}`)
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError(body.error ?? "We couldn't check your Microsoft 365 licences.");
          onStatusChange("error");
        } else {
          setData(body);
          onStatusChange(body?.selected ? "ok" : "no-seat");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError("We couldn't check your Microsoft 365 licences.");
        onStatusChange("error");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // onStatusChange is a stable useCallback in the parent.
  }, [tenantId, onStatusChange]);

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
          Add a seat in the Microsoft 365 admin center, then come back — we re-check
          automatically.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 pt-1">
          <div>
            <p className="font-medium flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 shrink-0" />
              These work
            </p>
            <ul className="mt-1 space-y-0.5 list-disc pl-4">
              <li>Exchange Online Plan 1 or 2 — cheapest, mailbox only</li>
              <li>Microsoft 365 Business Basic, Standard or Premium</li>
              <li>Office 365 E1, E3 or E5</li>
              <li>Microsoft 365 E3 or E5</li>
            </ul>
          </div>
          <div>
            <p className="font-medium flex items-center gap-1">
              <XCircle className="h-3 w-3 shrink-0" />
              These don&apos;t
            </p>
            <ul className="mt-1 space-y-0.5 list-disc pl-4">
              <li>Power Automate Free, Power Apps Free</li>
              <li>Microsoft Teams Essentials or Exploratory</li>
              <li>Any free or trial plan without Exchange Online</li>
            </ul>
          </div>
        </div>

        <p className="text-[10px]">
          The rule is simply whether the licence includes an Exchange Online mailbox.
          Free plans often look valid in the admin center because they carry a
          directory-only Exchange entry, but no mailbox is ever created — so we check
          for a real one rather than trusting the licence name.
        </p>
      </div>
    );
  }

  const name = agentName || "Your agent";
  const included = caps.filter(([, on]) => on);
  const missing = caps.filter(([, on]) => !on);
  const alternatives = (data.usable ?? []).filter(
    (s) => s.skuPartNumber !== data.selected!.skuPartNumber,
  );

  return (
    <div className="rounded-lg border overflow-hidden">
      {/* The licence is the headline: it is what gets consumed and what decides
          everything below it. Previously it was set in the same small type as the
          surrounding help text, which read as a footnote rather than a decision. */}
      <div className="border-b bg-muted/40 px-4 py-3">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Licence {name} will use
        </p>
        <div className="mt-0.5 flex items-baseline justify-between gap-3">
          <p className="text-base font-semibold">{data.selected.displayName}</p>
          <span className="shrink-0 text-xs text-muted-foreground">
            {data.selected.seatsFree} seat{data.selected.seatsFree === 1 ? "" : "s"} free
          </span>
        </div>

        {/* Say why this one. The platform picks cheapest-adequate from the licences
            that can actually carry a mailbox, and a buyer who is not told that has
            no way to know a choice was made, or that buying differently would
            change it. */}
        <p className="mt-1.5 text-xs text-muted-foreground">
          {alternatives.length > 0 ? (
            <>
              Chosen because it is the least expensive of your{" "}
              {(data.usable?.length ?? 1)} licences that include a mailbox. Also
              available:{" "}
              <span className="text-foreground">
                {alternatives.map((s) => s.displayName).join(", ")}
              </span>
              .
            </>
          ) : (
            <>This is the only licence in your organization that includes a mailbox.</>
          )}
        </p>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div>
          <p className="text-xs font-medium mb-1.5">What {name} will be able to do</p>
          <ul className="space-y-1">
            {included.map(([label, , desc]) => (
              <li key={label} className="flex items-start gap-2 text-xs">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-green-600" />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="text-muted-foreground"> — {desc}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Only rendered when something is actually missing. An empty "cannot do"
            heading reads as a warning where there is nothing to warn about. */}
        {missing.length > 0 && (
          <div>
            <p className="text-xs font-medium mb-1.5 text-muted-foreground">
              Not included in this licence
            </p>
            <ul className="space-y-1">
              {missing.map(([label, , desc]) => (
                <li key={label} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <span className="font-medium">{label}</span> — {desc}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {name} still works without these. To include them, assign a licence that
              carries them and reconnect.
            </p>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground border-t pt-2">
          {name} keeps this seat for as long as it works for you, and releases it when you
          fire it. SharePoint access comes from the Marketplace app rather than this
          licence, so it works on any plan.
        </p>
      </div>
    </div>
  );
}

export function StepConnect() {
  const { state, updateState, setStep } = useHire();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [msConnected, setMsConnected] = useState(!!state.buyerMicrosoftTenantId);
  const [licensingStatus, setLicensingStatusRaw] = useState<LicensingStatus>("loading");
  // Stable identity so the child's effect doesn't refire on every parent render.
  const setLicensingStatus = useCallback((s: LicensingStatus) => setLicensingStatusRaw(s), []);

  // Nothing past this step is recoverable: the next step takes payment, and an agent
  // with no mailbox-capable seat cannot be provisioned no matter what is paid. This
  // used to be a warning the buyer could click straight past, which meant they could
  // be charged for a hire that was already guaranteed to fail.
  const blockedReason: string | null =
    state.workspaceProvider !== "MICROSOFT" || !msConnected
      ? "Connect your Microsoft 365 organization to continue — your agent needs a mailbox in your tenant."
      : licensingStatus === "loading"
        ? "Checking your Microsoft 365 licences…"
        : licensingStatus === "no-seat"
          ? "Add a Microsoft 365 seat before continuing — the hire cannot complete without one."
          : null;

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
                Microsoft 365 — SharePoint files, Outlook calendar, and its own
                licensed mailbox (e.g.{" "}
                <span className="font-mono">
                  {state.agentSlug}-&lt;your-org&gt;@agents.agentstore.it.com
                </span>
                ). All data stays in your tenant.
              </p>
            </div>
          </div>
        </div>
      )}

      {state.workspaceProvider === "MICROSOFT" && msConnected && (
        <LicensingSummary
          tenantId={state.buyerMicrosoftTenantId}
          agentName={state.hireName}
          onStatusChange={setLicensingStatus}
        />
      )}

      <div className="space-y-2">
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStep(2)}>
            Back
          </Button>
          <Button className="flex-1" onClick={() => setStep(4)} disabled={blockedReason !== null}>
            Continue
          </Button>
        </div>
        {blockedReason && (
          <p className="text-xs text-muted-foreground text-center">{blockedReason}</p>
        )}
      </div>
    </div>
  );
}
