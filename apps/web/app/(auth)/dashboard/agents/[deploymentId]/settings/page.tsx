"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Loader2 } from "lucide-react";

interface DeploymentSettings {
  agentName: string;
  weeklyDigestEmail: string | null;
  autoUpdate: boolean;
  autonomyConfig: Record<string, string>;
}

export default function SettingsPage() {
  const params = useParams();
  const deploymentId = params.deploymentId as string;
  const [settings, setSettings] = useState<DeploymentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}`)
      .then((r) => r.json())
      .then((data) => {
        setSettings({
          agentName: data.agentName,
          weeklyDigestEmail: data.weeklyDigestEmail,
          autoUpdate: data.autoUpdate,
          autonomyConfig: data.autonomyConfig || {},
        });
      });
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
      }),
    });

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

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
