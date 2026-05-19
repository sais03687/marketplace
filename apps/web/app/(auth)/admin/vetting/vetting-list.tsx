"use client";

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatPrice } from "@/lib/utils";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

// ── Types ────────────────────────────────────────────────────────────────────

interface VersionData {
  id: string;
  version: string;
  vetStatus: string;
  storagePath: string | null;
  manifestData: Record<string, unknown> | null;
  createdAt: string;
  agent: {
    name: string;
    slug: string;
    tagline: string;
    description: string;
    category: string;
    runtime: string;
    modelTier: string;
    pricePerMonth: number;
    creator: { displayName: string };
    capabilities: { name: string; description: string }[];
  };
}

type Tab = "overview" | "files" | "onboarding" | "sandbox";

// ── Helpers ──────────────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  txt: "text",
  sh: "bash",
  cfg: "ini",
};

function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "text";
}

// ── Main Component ───────────────────────────────────────────────────────────

export function VettingList({ versions }: { versions: VersionData[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (versions.length === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-lg font-medium">No packages to review</p>
        <p className="text-muted-foreground">
          All submitted packages have been reviewed.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {versions.map((version) => (
        <VettingCard
          key={version.id}
          version={version}
          isExpanded={expandedId === version.id}
          onToggle={() =>
            setExpandedId((prev) =>
              prev === version.id ? null : version.id,
            )
          }
        />
      ))}
    </div>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

function VettingCard({
  version,
  isExpanded,
  onToggle,
}: {
  version: VersionData;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [deciding, setDeciding] = useState(false);
  const [decided, setDecided] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");

  const handleDecision = useCallback(
    async (decision: string) => {
      if (decision === "FAILED" && !feedback.trim()) {
        alert("Please provide feedback for the creator before rejecting.");
        return;
      }
      setDeciding(true);
      try {
        const res = await fetch(
          `/api/packages/${version.id}/vet-decision`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision, feedback: feedback.trim() }),
          },
        );
        if (res.ok) {
          setDecided(decision);
        } else {
          const data = await res.json().catch(() => ({}));
          alert(`Error: ${data.error ?? res.statusText}`);
        }
      } finally {
        setDeciding(false);
      }
    },
    [version.id, feedback],
  );

  if (decided) {
    return (
      <Card className="opacity-60">
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <span className="font-medium">{version.agent.name}</span>
            <Badge
              variant={decided === "MANUALLY_APPROVED" ? "success" : "destructive"}
            >
              {decided === "MANUALLY_APPROVED" ? "Approved" : "Rejected"}
            </Badge>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-5">
        {/* Collapsed header */}
        <div
          className="flex cursor-pointer items-start justify-between"
          onClick={onToggle}
        >
          <div>
            <h3 className="font-semibold">{version.agent.name}</h3>
            <p className="text-xs text-muted-foreground">
              by {version.agent.creator.displayName} &middot; v
              {version.version} &middot;{" "}
              {version.agent.slug}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {version.agent.tagline}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={version.vetStatus === "PASSED" ? "success" : "warning"}
              className="text-[10px]"
            >
              {version.vetStatus}
            </Badge>
            <span className="text-muted-foreground text-sm">
              {isExpanded ? "▲" : "▼"}
            </span>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Submitted {formatDate(version.createdAt)}</span>
          <span>
            {version.agent.runtime} &middot; {version.agent.modelTier} &middot;{" "}
            {formatPrice(version.agent.pricePerMonth)}/mo
          </span>
        </div>

        {/* Expanded detail view */}
        {isExpanded && (
          <DetailPanel version={version} />
        )}

        {/* Feedback + action buttons */}
        {isExpanded && (
          <div className="mt-4 space-y-3 border-t pt-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Feedback to creator <span className="text-destructive">*</span> (required for rejection, optional for approval)
              </label>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="e.g. 'agent.py is missing error handling for malformed emails' or 'Looks great, approved!'"
                rows={3}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={deciding}
                onClick={() => handleDecision("FAILED")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={deciding}
                onClick={() => handleDecision("MANUALLY_APPROVED")}
              >
                Approve
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Detail Panel ─────────────────────────────────────────────────────────────

function DetailPanel({ version }: { version: VersionData }) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="mt-4 border-t pt-4">
      {/* Tab bar */}
      <div className="flex gap-1 border-b">
        {(["overview", "sandbox", "files", "onboarding"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === "overview" && <OverviewTab version={version} />}
        {tab === "sandbox" && <SandboxTab versionId={version.id} runtime={version.agent.runtime} />}
        {tab === "files" && <FilesTab versionId={version.id} />}
        {tab === "onboarding" && <OnboardingTab versionId={version.id} />}
      </div>
    </div>
  );
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ version }: { version: VersionData }) {
  const manifest = version.manifestData;

  return (
    <div className="space-y-4 text-sm">
      {/* Description */}
      <div>
        <h4 className="mb-1 font-semibold text-muted-foreground">Description</h4>
        <p className="whitespace-pre-wrap">{version.agent.description}</p>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetaItem label="Category" value={version.agent.category.replace(/_/g, " ")} />
        <MetaItem label="Runtime" value={version.agent.runtime} />
        <MetaItem label="Model Tier" value={version.agent.modelTier} />
        <MetaItem label="Price" value={`${formatPrice(version.agent.pricePerMonth)}/mo`} />
      </div>

      {/* Capabilities */}
      {version.agent.capabilities.length > 0 && (
        <div>
          <h4 className="mb-2 font-semibold text-muted-foreground">Capabilities</h4>
          <div className="space-y-1">
            {version.agent.capabilities.map((cap) => (
              <div key={cap.name} className="flex gap-2">
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {cap.name}
                </Badge>
                <span className="text-muted-foreground">{cap.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manifest extras */}
      {manifest && (
        <div>
          <h4 className="mb-1 font-semibold text-muted-foreground">
            Raw Manifest
          </h4>
          <pre className="max-h-60 overflow-auto rounded bg-muted p-3 text-xs">
            {JSON.stringify(manifest, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-muted p-2">
      <div className="text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

// ── Files Tab ────────────────────────────────────────────────────────────────

function FilesTab({ versionId }: { versionId: string }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load file list on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/packages/${versionId}/files?action=list`,
        );
        if (!res.ok) throw new Error("Failed to load file list");
        const data = await res.json();
        if (!cancelled) setFiles(data.files);
      } catch (err: unknown) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load files");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [versionId]);

  const loadFileContent = useCallback(
    async (path: string) => {
      setSelectedFile(path);
      setFileContent(null);
      try {
        const res = await fetch(
          `/api/packages/${versionId}/files?action=read&path=${encodeURIComponent(path)}`,
        );
        if (!res.ok) throw new Error("Failed to read file");
        const data = await res.json();
        setFileContent(data.content);
      } catch {
        setFileContent("// Error loading file");
      }
    },
    [versionId],
  );

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading files...</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!files || files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No stored package files found.
      </p>
    );
  }

  return (
    <div className="flex gap-4" style={{ minHeight: 300 }}>
      {/* File tree */}
      <div className="w-48 shrink-0 space-y-0.5 overflow-auto border-r pr-3">
        {files.map((f) => (
          <button
            key={f}
            className={`block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors ${
              selectedFile === f
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
            onClick={() => loadFileContent(f)}
            title={f}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Code viewer */}
      <div className="min-w-0 flex-1 overflow-auto">
        {selectedFile && fileContent !== null ? (
          <SyntaxHighlighter
            language={langFromPath(selectedFile)}
            style={oneDark}
            showLineNumbers
            customStyle={{
              margin: 0,
              borderRadius: 6,
              fontSize: 12,
              maxHeight: 500,
            }}
          >
            {fileContent}
          </SyntaxHighlighter>
        ) : selectedFile ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select a file to view its contents.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Sandbox Tab ───────────────────────────────────────────────────────────────

interface SandboxTestDetail {
  name: string;
  passed: boolean;
  httpStatus?: number;
  responseBody?: string;
  error?: string;
}

interface SandboxStep {
  name: string;
  status: "pass" | "fail" | "skip" | "warn";
  detail: string;
  findings?: string[];
  testDetails?: SandboxTestDetail[];
  logLines?: string[];
}

interface SandboxReport {
  runAt?: string;
  slug?: string;
  version?: string;
  runtime?: string;
  steps?: SandboxStep[];
  overallStatus?: "pass" | "fail";
  summary?: string;
  status?: string; // "queued" | "running"
  startedAt?: string;
  queuedAt?: string;
}

// ── Test Builder types ───────────────────────────────────────────────────────

interface TestDraft {
  id: string;
  name: string;
  method: string;
  endpoint: string;
  expectStatus: string;
  body: string;       // raw JSON string
  showBody: boolean;
}

// ── Test Builder ─────────────────────────────────────────────────────────────

let _draftCounter = 0;
function newDraft(overrides: Partial<TestDraft> = {}): TestDraft {
  return {
    id: `draft-${++_draftCounter}`,
    name: "",
    method: "GET",
    endpoint: "",
    expectStatus: "200",
    body: "",
    showBody: false,
    ...overrides,
  };
}

function draftsToPayload(drafts: TestDraft[]): unknown[] {
  return drafts
    .filter((d) => d.endpoint.trim())
    .map((d) => {
      const obj: Record<string, unknown> = {
        name: d.name || `${d.method} ${d.endpoint}`,
        endpoint: d.endpoint,
        method: d.method,
        expectStatus: parseInt(d.expectStatus, 10) || 200,
      };
      if (d.body.trim()) {
        try { obj.body = JSON.parse(d.body); } catch { obj.body = d.body; }
      }
      return obj;
    });
}

function draftsToJson(drafts: TestDraft[]): string {
  return JSON.stringify(draftsToPayload(drafts), null, 2);
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function TestBuilder({
  drafts,
  onChange,
  disabled,
}: {
  drafts: TestDraft[];
  onChange: (drafts: TestDraft[]) => void;
  disabled: boolean;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonErr, setJsonErr] = useState<string | null>(null);

  const enterJsonMode = () => {
    setJsonText(drafts.length > 0 ? draftsToJson(drafts) : "[]");
    setJsonErr(null);
    setJsonMode(true);
  };

  const exitJsonMode = () => {
    try {
      const parsed = JSON.parse(jsonText.trim() || "[]");
      if (!Array.isArray(parsed)) { setJsonErr("Must be a JSON array"); return; }
      // Convert parsed array back to drafts
      const newDrafts: TestDraft[] = parsed.map((item: any) => newDraft({
        name: item.name ?? "",
        method: (item.method ?? "GET").toUpperCase(),
        endpoint: item.endpoint ?? "",
        expectStatus: String(item.expectStatus ?? 200),
        body: item.body !== undefined ? JSON.stringify(item.body, null, 2) : "",
      }));
      onChange(newDrafts);
      setJsonErr(null);
      setJsonMode(false);
    } catch (e: unknown) {
      setJsonErr(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  const update = (id: string, patch: Partial<TestDraft>) => {
    onChange(drafts.map((d) => d.id === id ? { ...d, ...patch } : d));
  };
  const remove = (id: string) => onChange(drafts.filter((d) => d.id !== id));
  const add = () => onChange([...drafts, newDraft()]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Custom tests {drafts.length > 0 && `(${drafts.length})`}
        </span>
        <button
          type="button"
          onClick={jsonMode ? exitJsonMode : enterJsonMode}
          disabled={disabled}
          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-40"
        >
          {jsonMode ? "← Back to form" : "Edit as JSON"}
        </button>
      </div>

      {jsonMode ? (
        <div>
          <textarea
            value={jsonText}
            onChange={(e) => { setJsonText(e.target.value); setJsonErr(null); }}
            rows={10}
            spellCheck={false}
            className="w-full rounded border bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {jsonErr && <p className="mt-0.5 text-xs text-destructive">{jsonErr}</p>}
          <p className="mt-1 text-[10px] text-muted-foreground">
            Click "← Back to form" to apply changes.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {drafts.length === 0 && (
            <p className="text-[11px] text-muted-foreground italic">
              No custom tests — only the 5 built-in platform tests will run.
            </p>
          )}

          {drafts.map((d) => (
            <div key={d.id} className="rounded border bg-muted/30 p-2 space-y-1.5">
              {/* Row 1: method + endpoint + remove */}
              <div className="flex items-center gap-1.5">
                <select
                  value={d.method}
                  onChange={(e) => update(d.id, { method: e.target.value })}
                  disabled={disabled}
                  className="rounded border bg-background px-1.5 py-1 text-xs font-mono w-20 focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {METHODS.map((m) => <option key={m}>{m}</option>)}
                </select>
                <input
                  type="text"
                  value={d.endpoint}
                  onChange={(e) => update(d.id, { endpoint: e.target.value })}
                  disabled={disabled}
                  placeholder="/endpoint/path"
                  className="flex-1 rounded border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
                />
                <button
                  type="button"
                  onClick={() => remove(d.id)}
                  disabled={disabled}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-40 px-1 text-sm leading-none"
                  title="Remove test"
                >
                  ×
                </button>
              </div>

              {/* Row 2: name + expected status */}
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={d.name}
                  onChange={(e) => update(d.id, { name: e.target.value })}
                  disabled={disabled}
                  placeholder="Test name (optional)"
                  className="flex-1 rounded border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
                />
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-muted-foreground">expect</span>
                  <input
                    type="number"
                    value={d.expectStatus}
                    onChange={(e) => update(d.id, { expectStatus: e.target.value })}
                    disabled={disabled}
                    className="w-14 rounded border bg-background px-1.5 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              {/* Body toggle + editor */}
              <div>
                <button
                  type="button"
                  onClick={() => update(d.id, { showBody: !d.showBody })}
                  disabled={disabled}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {d.showBody ? "▾ Hide body" : "▸ Add body (JSON)"}
                </button>
                {d.showBody && (
                  <textarea
                    value={d.body}
                    onChange={(e) => update(d.id, { body: e.target.value })}
                    disabled={disabled}
                    placeholder='{ "key": "value" }'
                    rows={4}
                    spellCheck={false}
                    className="mt-1 w-full rounded border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
                  />
                )}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={add}
            disabled={disabled}
            className="text-xs text-primary hover:underline disabled:opacity-40"
          >
            + Add test
          </button>
        </div>
      )}
    </div>
  );
}

// ── Sandbox Tab ───────────────────────────────────────────────────────────────

function SandboxTab({ versionId, runtime }: { versionId: string; runtime: string }) {
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<SandboxReport | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showConfig, setShowConfig] = useState(false);
  const [skipDefaultTests, setSkipDefaultTests] = useState(false);
  const [drafts, setDrafts] = useState<TestDraft[]>([]);
  const [viewMode, setViewMode] = useState<"pretty" | "terminal">("pretty");

  const isCustom = runtime === "CUSTOM";

  // Load existing results on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/packages/${versionId}/vet-sandbox`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.testResults) {
          setReport(data.testResults as SandboxReport);
        }
      } catch { /* best effort */ }
    })();
    return () => { cancelled = true; };
  }, [versionId]);

  // Polling loop while running/queued
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/packages/${versionId}/vet-sandbox`);
        if (!res.ok) return;
        const data = await res.json();
        const r = data.testResults as SandboxReport | null;
        if (cancelled) return;
        setReport(r);
        if (r?.steps && r.steps.length > 0) setPolling(false);
      } catch { /* best effort */ }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [polling, versionId]);

  const runSandbox = useCallback(async () => {
    setLoading(true);
    setError(null);
    const customTests = draftsToPayload(drafts);
    try {
      const res = await fetch(`/api/packages/${versionId}/vet-sandbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customTests: customTests.length > 0 ? customTests : undefined,
          skipDefaultTests: skipDefaultTests || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to queue vetting job"); return; }
      setReport({ status: "queued", queuedAt: new Date().toISOString() });
      setPolling(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [versionId, drafts, skipDefaultTests]);

  const isRunning = report?.status === "queued" || report?.status === "running";
  const hasDone = report?.steps && report.steps.length > 0;

  return (
    <div className="space-y-4 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">Automated Vetting Sandbox</p>
          <p className="text-xs text-muted-foreground">
            {isCustom
              ? "Builds the Docker image and fires synthetic HTTP tests against the container."
              : "Static validation only — sandbox requires custom runtime."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isCustom && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowConfig((v) => !v)}
              disabled={isRunning}
              className="text-xs"
            >
              {showConfig ? "Hide config ▲" : "Configure tests ▼"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={loading || isRunning || !isCustom}
            onClick={runSandbox}
            title={!isCustom ? "Sandbox vetting is only available for custom runtime packages" : undefined}
          >
            {isRunning ? "Running…" : loading ? "Queuing…" : "Run Sandbox"}
          </Button>
        </div>
      </div>

      {/* Config panel */}
      {showConfig && isCustom && (
        <div className="rounded border bg-muted/30 p-3 space-y-3">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={skipDefaultTests}
              onChange={(e) => setSkipDefaultTests(e.target.checked)}
              disabled={isRunning}
              className="h-3.5 w-3.5 rounded border"
            />
            <span className="text-xs">
              Skip built-in platform tests
              <span className="ml-1 text-muted-foreground">
                (health, memory, skills, onboarding, email)
              </span>
            </span>
          </label>

          <TestBuilder drafts={drafts} onChange={setDrafts} disabled={isRunning} />

          <div className="border-t pt-3 mt-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Built-in platform tests {skipDefaultTests && <span className="text-yellow-600">(skipped)</span>}
              </span>
            </div>
            <div className="rounded bg-gray-950 text-gray-100 font-mono text-[10px] p-3 overflow-auto max-h-64">
              <pre>{JSON.stringify([
                {
                  name: "GET /internal/health",
                  description: "Verifies container is up. Checks response body contains { ok: true }.",
                  endpoint: "/internal/health",
                  method: "GET",
                  expectStatus: 200,
                  validate: "body.ok === true"
                },
                {
                  name: "GET /internal/memory",
                  description: "Verifies memory subsystem loaded. Checks response contains { memory: {...} }.",
                  endpoint: "/internal/memory",
                  method: "GET",
                  expectStatus: 200,
                  validate: "typeof body.memory !== 'undefined'"
                },
                {
                  name: "GET /internal/skills",
                  description: "Verifies skill registry loaded. Checks response contains { skills: [...] }.",
                  endpoint: "/internal/skills",
                  method: "GET",
                  expectStatus: 200,
                  validate: "Array.isArray(body.skills)"
                },
                {
                  name: "POST /hooks/agent (onboarding)",
                  description: "Fires the agent hook with an onboarding message. Checks HTTP 200 within 15s.",
                  endpoint: "/hooks/agent",
                  method: "POST",
                  body: { message: "Hello, please introduce yourself.", name: "hook:onboarding", sessionKey: "hook:onboarding" },
                  expectStatus: 200,
                  timeout: "15s"
                },
                {
                  name: "POST /hooks/agentmail (email)",
                  description: "Fires the email hook with a synthetic email from manager@vet.internal. Checks HTTP 200 within 15s.",
                  endpoint: "/hooks/agentmail",
                  method: "POST",
                  body: { from: { address: "manager@vet.internal" }, subject: "Vetting test", text: "Synthetic test. Please acknowledge." },
                  expectStatus: 200,
                  timeout: "15s"
                }
              ], null, 2)}</pre>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {isRunning && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-xs">
            {report?.status === "queued" ? "Queued — waiting for provisioning service…" : "Building and testing…"}
          </span>
        </div>
      )}

      {hasDone && report && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                report.overallStatus === "pass"
                  ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
              }`}
            >
              {report.overallStatus === "pass" ? "✓ PASS" : "✗ FAIL"}
            </span>
            <span className="text-xs text-muted-foreground flex-1">{report.summary}</span>
            <div className="flex items-center gap-1 ml-auto">
              <button
                type="button"
                onClick={() => setViewMode("pretty")}
                className={`px-2 py-0.5 rounded text-[10px] font-medium ${viewMode === "pretty" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground border"}`}
              >
                Results
              </button>
              <button
                type="button"
                onClick={() => setViewMode("terminal")}
                className={`px-2 py-0.5 rounded text-[10px] font-medium ${viewMode === "terminal" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground border"}`}
              >
                Terminal
              </button>
              {report.runAt && (
                <span className="text-xs text-muted-foreground ml-2">
                  {new Date(report.runAt).toLocaleString()}
                </span>
              )}
            </div>
          </div>

          {viewMode === "terminal" ? (
            <TerminalView steps={report.steps!} />
          ) : (
            <div className="rounded border divide-y">
              {report.steps!.map((step, i) => (
                <StepRow key={i} step={step} />
              ))}
            </div>
          )}
        </div>
      )}

      {!hasDone && !isRunning && !error && (
        <p className="text-xs text-muted-foreground">
          {isCustom
            ? "No sandbox results yet. Click \"Run Sandbox\" to start."
            : "This package uses the OpenClaw runtime. Sandbox vetting requires custom runtime packages."}
        </p>
      )}
    </div>
  );
}

// ── Terminal View ─────────────────────────────────────────────────────────────

function TerminalView({ steps }: { steps: SandboxStep[] }) {
  return (
    <div className="rounded bg-gray-950 text-gray-100 font-mono text-[11px] p-4 overflow-auto max-h-[600px] space-y-3">
      {steps.map((step, i) => (
        <div key={i}>
          <div className={`font-bold mb-1 ${
            step.status === "pass" ? "text-green-400" :
            step.status === "fail" ? "text-red-400" :
            step.status === "skip" ? "text-gray-500" : "text-yellow-400"
          }`}>
            [{step.status.toUpperCase()}] {step.name} — {step.detail}
          </div>
          {step.logLines && step.logLines.map((line, j) => (
            <div key={j} className="text-gray-400 pl-2 leading-relaxed whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
          {step.findings && step.findings.length > 0 && !step.logLines && step.findings.map((f, j) => (
            <div key={j} className="text-red-400 pl-2">⚠ {f}</div>
          ))}
          {step.testDetails && !step.logLines && step.testDetails.map((td, j) => (
            <div key={j} className={`pl-2 ${td.passed ? "text-green-400" : "text-red-400"}`}>
              {td.passed ? "✓" : "✗"} {td.name}{td.httpStatus !== undefined ? ` → HTTP ${td.httpStatus}` : ""}{td.error ? `: ${td.error}` : ""}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Step Row (with expandable test details) ───────────────────────────────────

function StepRow({ step }: { step: SandboxStep }) {
  const [expanded, setExpanded] = useState(step.status === "fail");
  const hasDetails = (step.testDetails && step.testDetails.length > 0) ||
                     (step.findings && step.findings.length > 0) ||
                     (step.logLines && step.logLines.length > 0);

  return (
    <div className="px-3 py-2">
      <div
        className={`flex items-center justify-between ${hasDetails ? "cursor-pointer select-none" : ""}`}
        onClick={() => hasDetails && setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          {hasDetails && (
            <span className="text-[10px] text-muted-foreground">{expanded ? "▾" : "▸"}</span>
          )}
          <span className="font-medium">{step.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{step.detail}</span>
          <StatusBadge status={step.status} />
        </div>
      </div>

      {expanded && hasDetails && (
        <div className="mt-2 space-y-1.5 pl-4">
          {/* Per-test response rows */}
          {step.testDetails?.map((td, j) => (
            <TestDetailRow key={j} td={td} />
          ))}

          {/* Static findings (manifest errors, dangerous patterns, etc.) */}
          {step.findings && step.findings.length > 0 && !step.testDetails && (
            <ul className="space-y-0.5">
              {step.findings.map((f, j) => (
                <li key={j} className="text-xs text-destructive font-mono bg-destructive/5 rounded px-2 py-0.5">
                  {f}
                </li>
              ))}
            </ul>
          )}

          {step.logLines && step.logLines.length > 0 && !step.testDetails && (
            <div className="mt-2 rounded bg-gray-950 text-gray-300 font-mono text-[10px] p-2 max-h-48 overflow-auto">
              {step.logLines.map((line, j) => (
                <div key={j} className="whitespace-pre-wrap break-all leading-relaxed">{line}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TestDetailRow({ td }: { td: SandboxTestDetail }) {
  const [showBody, setShowBody] = useState(false);

  return (
    <div className={`rounded border text-xs ${td.passed ? "border-border" : "border-destructive/40"}`}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className={`font-mono text-[10px] font-semibold ${td.passed ? "text-green-600 dark:text-green-400" : "text-destructive"}`}>
          {td.passed ? "✓" : "✗"}
        </span>
        <span className="flex-1 font-medium truncate">{td.name}</span>
        {td.httpStatus !== undefined && (
          <span className={`font-mono text-[10px] rounded px-1 py-0.5 ${
            td.httpStatus >= 200 && td.httpStatus < 300
              ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
              : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
          }`}>
            HTTP {td.httpStatus}
          </span>
        )}
        {td.responseBody && (
          <button
            type="button"
            onClick={() => setShowBody((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-1"
          >
            {showBody ? "hide response" : "see response"}
          </button>
        )}
      </div>

      {td.error && (
        <div className="px-2 pb-1.5 text-[11px] text-destructive font-mono">
          {td.error}
        </div>
      )}

      {showBody && td.responseBody && (
        <pre className="border-t px-2 py-1.5 text-[10px] font-mono text-muted-foreground overflow-auto max-h-40 whitespace-pre-wrap break-all">
          {td.responseBody}
        </pre>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "pass" | "fail" | "skip" | "warn" }) {
  const cfg = {
    pass: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    fail: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    skip: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
    warn: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  }[status];
  const label = { pass: "PASS", fail: "FAIL", skip: "SKIP", warn: "WARN" }[status];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${cfg}`}>
      {label}
    </span>
  );
}

// ── Onboarding Tab ───────────────────────────────────────────────────────────

function OnboardingTab({ versionId }: { versionId: string }) {
  const [questions, setQuestions] = useState<unknown[] | null>(null);
  const [memoryTemplate, setMemoryTemplate] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Fetch questions.json
        const qRes = await fetch(
          `/api/packages/${versionId}/files?action=read&path=${encodeURIComponent("onboarding/questions.json")}`,
        );
        if (qRes.ok) {
          const qData = await qRes.json();
          try {
            if (!cancelled) setQuestions(JSON.parse(qData.content));
          } catch {
            // malformed JSON — ignore
          }
        }

        // Fetch MEMORY_TEMPLATE.md
        const mRes = await fetch(
          `/api/packages/${versionId}/files?action=read&path=${encodeURIComponent("onboarding/MEMORY_TEMPLATE.md")}`,
        );
        if (mRes.ok) {
          const mData = await mRes.json();
          if (!cancelled) setMemoryTemplate(mData.content);
        }
      } catch (err: unknown) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load onboarding data",
          );
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [versionId]);

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">Loading onboarding data...</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!questions && !memoryTemplate) {
    return (
      <p className="text-sm text-muted-foreground">
        No onboarding files found in this package.
      </p>
    );
  }

  return (
    <div className="space-y-6 text-sm">
      {/* Questions */}
      {questions && Array.isArray(questions) && (
        <div>
          <h4 className="mb-2 font-semibold text-muted-foreground">
            Onboarding Questions ({questions.length})
          </h4>
          <div className="space-y-3">
            {questions.map((q: any, i: number) => (
              <div key={i} className="rounded border p-3">
                <p className="font-medium">
                  {i + 1}. {q.question ?? q.text ?? JSON.stringify(q)}
                </p>
                {q.type && (
                  <span className="text-xs text-muted-foreground">
                    Type: {q.type}
                  </span>
                )}
                {q.options && Array.isArray(q.options) && (
                  <ul className="ml-4 mt-1 list-disc text-muted-foreground">
                    {q.options.map((opt: string, j: number) => (
                      <li key={j}>{opt}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Memory template */}
      {memoryTemplate && (
        <div>
          <h4 className="mb-2 font-semibold text-muted-foreground">
            Memory Template Preview
          </h4>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
            {memoryTemplate}
          </pre>
        </div>
      )}
    </div>
  );
}
