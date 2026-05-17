"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Loader2, X } from "lucide-react";

type ApprovalPolicy = "always" | "external-only" | "risk-based" | "never";

interface AutonomyConfig {
  approvalPolicy?: ApprovalPolicy;
  approvalRiskThreshold?: number;
  autoApproveList?: string[];
  requireApprovalList?: string[];
  [key: string]: unknown;
}

interface DeploymentSettings {
  agentName: string;
  weeklyDigestEmail: string | null;
  autoUpdate: boolean;
  autonomyConfig: AutonomyConfig;
  runtime: string;
}

interface AllowlistState {
  allowedEmails: string[];
  companyDomain: string;
  managerEmail: string | null;
}

const POLICY_OPTIONS: { value: ApprovalPolicy; label: string; help: string }[] = [
  {
    value: "always",
    label: "Always ask",
    help: "I want to review every outbound email before it is sent.",
  },
  {
    value: "external-only",
    label: "External only (default)",
    help: "Only ask for recipients not on my team or in my contacts list.",
  },
  {
    value: "risk-based",
    label: "Risk-based",
    help: "Only ask for high-stakes, ambiguous, or irreversible messages.",
  },
  {
    value: "never",
    label: "Never ask",
    help: "Fully autonomous. Use with caution.",
  },
];

export default function SettingsPage() {
  const params = useParams();
  const deploymentId = params.deploymentId as string;
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [allowlist, setAllowlist] = useState<AllowlistState>({ allowedEmails: [], companyDomain: "", managerEmail: null });
  const [allowlistInput, setAllowlistInput] = useState("");
  const [savingAllowlist, setSavingAllowlist] = useState(false);
  const [savedAllowlist, setSavedAllowlist] = useState(false);

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}`)
      .then((r) => r.json())
      .then((data) => {
        setSettings({
          agentName: data.agentName,
          weeklyDigestEmail: data.weeklyDigestEmail,
          autoUpdate: data.autoUpdate,
          autonomyConfig: data.autonomyConfig || {},
          runtime: data.agent?.runtime || "CUSTOM",
        });
      });
    fetch(`/api/deployments/${deploymentId}/allowlist`)
      .then((r) => r.json())
      .then((data) => setAllowlist({
        allowedEmails: data.allowedEmails ?? [],
        companyDomain: data.companyDomain ?? "",
        managerEmail: data.managerEmail ?? null,
      }));
  }, [deploymentId]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);

    await fetch(`/api/deployments/${deploymentId}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: settings.agentName,
        weeklyDigestEmail: settings.weeklyDigestEmail || undefined,
        autoUpdate: settings.autoUpdate,
        autonomyConfig: settings.autonomyConfig,
      }),
    });

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updatePolicy = (patch: Partial<AutonomyConfig>) => {
    if (!settings) return;
    setSettings({
      ...settings,
      autonomyConfig: { ...settings.autonomyConfig, ...patch },
    });
  };

  const handleSaveAllowlist = async () => {
    setSavingAllowlist(true);
    setSavedAllowlist(false);
    await fetch(`/api/deployments/${deploymentId}/allowlist`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowedEmails: allowlist.allowedEmails }),
    });
    setSavingAllowlist(false);
    setSavedAllowlist(true);
    setTimeout(() => setSavedAllowlist(false), 2000);
  };

  const addAllowlistEntry = () => {
    const entry = allowlistInput.toLowerCase().trim();
    if (!entry || allowlist.allowedEmails.includes(entry)) {
      setAllowlistInput("");
      return;
    }
    setAllowlist((al) => ({ ...al, allowedEmails: [...al.allowedEmails, entry] }));
    setAllowlistInput("");
  };

  const removeAllowlistEntry = (entry: string) => {
    setAllowlist((al) => ({ ...al, allowedEmails: al.allowedEmails.filter((e) => e !== entry) }));
  };

  const linesToList = (s: string): string[] =>
    s
      .split(/[\n,;]/)
      .map((x) => x.trim())
      .filter(Boolean);

  if (!settings) {
    return <div className="text-muted-foreground">Loading settings...</div>;
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground">
          Configure your AI employee.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium">Agent Name</label>
            <Input
              className="mt-1"
              value={settings.agentName}
              onChange={(e) =>
                setSettings({ ...settings, agentName: e.target.value })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium">Weekly Digest Email</label>
            <Input
              className="mt-1"
              type="email"
              value={settings.weeklyDigestEmail || ""}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  weeklyDigestEmail: e.target.value || null,
                })
              }
              placeholder="team@company.com"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Approval Policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              Control when this agent must ask you before sending an email.
            </p>
            <div className="space-y-2">
              {POLICY_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-start gap-2 cursor-pointer rounded border p-3 hover:bg-accent/40"
                >
                  <input
                    type="radio"
                    name="approvalPolicy"
                    value={opt.value}
                    checked={
                      (settings.autonomyConfig.approvalPolicy ??
                        "external-only") === opt.value
                    }
                    onChange={() => updatePolicy({ approvalPolicy: opt.value })}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-xs text-muted-foreground">{opt.help}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {settings.autonomyConfig.approvalPolicy === "risk-based" && (
            <div>
              <label className="text-sm font-medium">
                Risk threshold (1-10)
              </label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={settings.autonomyConfig.approvalRiskThreshold ?? 6.0}
                onChange={(e) =>
                  updatePolicy({
                    approvalRiskThreshold: Number(e.target.value) || 6.0,
                  })
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Combined risk score at or above this triggers approval. Default
                is 6.0.
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium">
              Always auto-approve
            </label>
            <textarea
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              rows={3}
              placeholder="vendor@trusted.com&#10;@partner.io"
              value={(settings.autonomyConfig.autoApproveList ?? []).join("\n")}
              onChange={(e) =>
                updatePolicy({ autoApproveList: linesToList(e.target.value) })
              }
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Emails or @domains (one per line) that always send without
              asking.
            </p>
          </div>

          <div>
            <label className="text-sm font-medium">
              Always require approval
            </label>
            <textarea
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              rows={3}
              placeholder="ceo@company.com&#10;@sensitive-client.com"
              value={(settings.autonomyConfig.requireApprovalList ?? []).join(
                "\n",
              )}
              onChange={(e) =>
                updatePolicy({
                  requireApprovalList: linesToList(e.target.value),
                })
              }
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Overrides auto-approve. Use for high-sensitivity recipients.
            </p>
          </div>

          {settings.runtime === "OPENCLAW" && (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
              This agent runs on the OpenClaw runtime. Your policy is injected
              into its instructions at startup, so changes take effect after
              the next container restart (not on save).
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Email Allowlist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Restrict who can email this agent. Your company domain
            {allowlist.companyDomain ? ` (@${allowlist.companyDomain})` : ""} and manager
            email are always allowed. Leave empty to allow anyone.
          </p>

          {/* Tag list */}
          {allowlist.allowedEmails.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {allowlist.allowedEmails.map((entry) => (
                <span
                  key={entry}
                  className="flex items-center gap-1 rounded-full border bg-muted px-3 py-1 text-xs font-medium"
                >
                  {entry}
                  <button onClick={() => removeAllowlistEntry(entry)} className="ml-1 text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Add entry */}
          <div className="flex gap-2">
            <Input
              placeholder="alice@acme.com or @partner.io"
              value={allowlistInput}
              onChange={(e) => setAllowlistInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addAllowlistEntry()}
              className="flex-1"
            />
            <Button variant="outline" onClick={addAllowlistEntry} type="button">
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use <code className="rounded bg-muted px-1">@domain.com</code> to allow an entire domain. Press Enter or click Add.
          </p>

          <Button onClick={handleSaveAllowlist} disabled={savingAllowlist} size="sm">
            {savingAllowlist ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : savedAllowlist ? <Check className="mr-2 h-4 w-4" /> : null}
            {savingAllowlist ? "Saving..." : savedAllowlist ? "Saved" : "Save Allowlist"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Updates</CardTitle>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoUpdate}
              onChange={(e) =>
                setSettings({ ...settings, autoUpdate: e.target.checked })
              }
              className="h-4 w-4 rounded border-input"
            />
            <div>
              <p className="text-sm font-medium">Auto-update skills</p>
              <p className="text-xs text-muted-foreground">
                Automatically apply skill updates from the creator.
              </p>
            </div>
          </label>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : saved ? (
            <Check className="mr-2 h-4 w-4" />
          ) : null}
          {saving ? "Saving..." : saved ? "Saved" : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
