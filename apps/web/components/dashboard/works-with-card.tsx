"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, Loader2 } from "lucide-react";
import { WorksWithPicker, type WorksWithOption } from "./works-with-picker";

/** Settings: change which of the buyer's other agents this one works with. */
export function WorksWithCard({ deploymentId }: { deploymentId: string }) {
  const [options, setOptions] = useState<WorksWithOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}/works-with`)
      .then((r) => r.json())
      .then((d) => {
        setOptions(d.options ?? []);
        setSelected(d.worksWith ?? []);
      })
      .catch(() => setOptions([]));
  }, [deploymentId]);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/works-with`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worksWith: selected }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = await res.json();
      setSelected(d.worksWith ?? selected);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Works with your other agents</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The agents you tick are told about each other and can hand work to each other by email.
          It works both ways. If agents go back and forth more than a few times on one thread,
          they stop and you get an email.
        </p>
        {options === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <WorksWithPicker options={options} selected={selected} onChange={setSelected} disabled={saving} />
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {options && options.length > 0 && (
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : saved ? <Check className="mr-2 h-4 w-4" /> : null}
            {saved ? "Saved" : "Save"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
