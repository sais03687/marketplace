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

type Tab = "overview" | "files" | "onboarding";

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
        {(["overview", "files", "onboarding"] as Tab[]).map((t) => (
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
