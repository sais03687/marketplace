"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, Check, Plus, Trash2, Copy } from "lucide-react";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/creator/api-keys");
      if (res.ok) setKeys(await res.json());
    } catch {}
    setKeysLoading(false);
  };

  useEffect(() => { fetchKeys(); }, []);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/creator/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setKeyError(data.error || "Failed"); setCreating(false); return; }
      setRevealedKey(data.key);
      setShowCreate(false);
      setNewKeyName("");
      await fetchKeys();
    } catch { setKeyError("Network error"); }
    setCreating(false);
  };

  const handleCopy = async () => {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return; }
    setDeletingId(id);
    setConfirmDeleteId(null);
    try {
      await fetch(`/api/creator/api-keys/${id}`, { method: "DELETE" });
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch {}
    setDeletingId(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">API Keys</h2>
          <p className="text-sm text-muted-foreground">
            Upload agent packages from GitHub Actions without logging in.
          </p>
        </div>
        <Button size="sm" onClick={() => { setShowCreate(true); setRevealedKey(null); }}>
          <Plus className="mr-2 h-3 w-3" /> New Key
        </Button>
      </div>

      {showCreate && (
        <Card className="mb-4 border-primary/30">
          <CardContent className="p-4 space-y-3">
            <p className="text-sm font-medium">Name this key</p>
            <p className="text-xs text-muted-foreground">e.g. "GitHub Actions — my-agent repo"</p>
            <div className="flex gap-2">
              <Input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                autoFocus
              />
              <Button onClick={handleCreate} disabled={creating || !newKeyName.trim()}>
                {creating && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Create
              </Button>
              <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
            {keyError && <p className="text-sm text-red-500">{keyError}</p>}
          </CardContent>
        </Card>
      )}

      {revealedKey && (
        <Card className="mb-4 border-emerald-300 bg-emerald-50">
          <CardContent className="p-4 space-y-2">
            <p className="text-sm font-semibold text-emerald-800">
              Copy this key now — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-white border px-3 py-2 text-xs font-mono break-all select-all">
                {revealedKey}
              </code>
              <Button size="sm" variant="outline" onClick={handleCopy}>
                {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <Button size="sm" variant="ghost" className="text-xs" onClick={() => setRevealedKey(null)}>
              I've copied it, dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {keysLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <Card key={k.id}>
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="font-medium text-sm">{k.name}</span>
                  <div className="mt-1">
                    <code className="text-xs text-muted-foreground font-mono">
                      {k.keyPrefix}{"•".repeat(52)}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Created {formatDate(k.createdAt)}
                    {k.lastUsedAt ? ` · Last used ${formatDate(k.lastUsedAt)}` : " · Never used"}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {confirmDeleteId === k.id ? (
                    <>
                      <span className="text-xs text-red-600 font-medium">Revoke?</span>
                      <Button variant="destructive" size="sm" onClick={() => handleDelete(k.id)} disabled={deletingId === k.id}>
                        {deletingId === k.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => handleDelete(k.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CreatorSettingsPage() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/creator/profile")
      .then((res) => res.json())
      .then((data) => {
        if (data.displayName) setDisplayName(data.displayName);
        if (data.email) setEmail(data.email);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const res = await fetch("/api/creator/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, email }),
      });

      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Failed to save");
      }
    } catch {
      setError("Network error");
    }

    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Update your creator profile and manage API access.</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4">Profile</h2>
      <Card className="mt-0">
        <CardContent className="p-6 space-y-4">
          <div>
            <label className="text-sm font-medium">Display Name</label>
            <Input
              className="mt-1"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Your name or company name"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Email</label>
            <Input
              className="mt-1"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : saved ? (
              <Check className="mr-2 h-4 w-4" />
            ) : null}
            {saved ? "Saved" : "Save Changes"}
          </Button>
        </CardContent>
      </Card>
      </div>

      <ApiKeysSection />
    </div>
  );
}
