"use client";

import { useState, useEffect, useCallback, use } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Upload, ArrowLeft, Trash2, ChevronDown, Check, X, MinusCircle } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/utils";

interface VetStep {
  name: string;
  status: "pass" | "fail" | "skip" | string;
  detail?: string;
  logLines?: string[];
}

interface VetReport {
  status?: string;
  runAt?: string;
  steps?: VetStep[];
}

interface AgentVersion {
  id: string;
  version: string;
  vetStatus: string;
  changelog: string | null;
  publishedAt: string | null;
  createdAt: string;
  // The vetting run's own record. The API has always returned it - it is the
  // same object the platform writes during the sandbox run - and the page threw
  // it away, so a creator saw only PASSED/FAILED and never which probe failed or
  // why. Safe to show: the vet container is given only noop secrets
  // (LLM_API_KEY=vet-noop) and an ephemeral random hooks token, so its build and
  // runtime logs contain nothing platform-sensitive, and this endpoint already
  // 403s anyone who is not the owning creator.
  testResults?: VetReport | null;
  vetNotes?: string | null;
}

function StepIcon({ status }: { status: string }) {
  if (status === "pass") return <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0" />;
  if (status === "fail") return <X className="h-3.5 w-3.5 text-red-600 shrink-0" />;
  return <MinusCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
}

export default function VersionsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [changelog, setChangelog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${slug}/versions`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setVersions(Array.isArray(data) ? data : []);
      } else if (res.status === 401) {
        setError("Session expired — please sign in again.");
        setVersions([]);
      } else if (res.status === 403) {
        setError("You don't have access to this agent's versions.");
        setVersions([]);
      } else {
        setVersions([]);
      }
    } catch {
      setVersions([]);
    }
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append("package", file);
    if (changelog) formData.append("changelog", changelog);

    try {
      const res = await fetch(`/api/agents/${slug}/versions`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        setShowUpload(false);
        setFile(null);
        setChangelog("");
        setSuccessMsg("Version submitted for review. It will appear in the admin vetting queue.");
        setTimeout(() => setSuccessMsg(null), 6000);
        await fetchVersions();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Upload failed");
      }
    } catch {
      setError("Network error");
    }

    setUploading(false);
  };

  const handleDeleteVersion = async (versionId: string) => {
    if (confirmDeleteId !== versionId) {
      setConfirmDeleteId(versionId);
      return;
    }

    setDeletingId(versionId);
    setConfirmDeleteId(null);
    setError(null);

    try {
      const res = await fetch(`/api/packages/${versionId}`, { method: "DELETE" });
      if (res.ok) {
        const data = await res.json();
        const msg = data.pausedDeployments > 0
          ? `Version deleted. ${data.pausedDeployments} active deployment(s) have been paused and buyers notified.`
          : "Version deleted.";
        setSuccessMsg(msg);
        setTimeout(() => setSuccessMsg(null), 8000);
        await fetchVersions();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Delete failed");
      }
    } catch {
      setError("Network error");
    }

    setDeletingId(null);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/creator">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Versions</h1>
            <p className="text-sm text-muted-foreground">{slug}</p>
          </div>
        </div>
        <Button onClick={() => setShowUpload(!showUpload)}>
          <Upload className="mr-2 h-4 w-4" />
          New Version
        </Button>
      </div>

      {showUpload && (
        <Card className="mb-6">
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold">Upload New Version</h3>
            <div>
              <label className="text-sm font-medium">Package (zip)</label>
              <Input
                className="mt-1"
                type="file"
                accept=".zip"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Changelog</label>
              <Textarea
                className="mt-1"
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="What changed in this version?"
                rows={3}
              />
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <Button onClick={handleUpload} disabled={uploading || !file}>
              {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Upload & Submit for Review
            </Button>
          </CardContent>
        </Card>
      )}

      {successMsg && (
        <div className="mb-4 rounded-md bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
          {successMsg}
        </div>
      )}

      {error && !showUpload && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {versions.length === 0 ? (
          <p className="text-muted-foreground">No versions found.</p>
        ) : (
          versions.map((v) => (
            <Card key={v.id}>
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">v{v.version}</span>
                    <Badge
                      variant={
                        v.vetStatus === "MANUALLY_APPROVED" || v.vetStatus === "PASSED"
                          ? "success"
                          : v.vetStatus === "FAILED"
                            ? "destructive"
                            : "secondary"
                      }
                      className="text-[10px]"
                    >
                      {v.vetStatus}
                    </Badge>
                  </div>
                  {v.changelog && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-1">
                      {v.changelog}
                    </p>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(v.createdAt)}
                  </span>
                </div>

                <div className="flex items-center gap-2 ml-4 shrink-0">
                  {confirmDeleteId === v.id ? (
                    <>
                      <span className="text-xs text-red-600 font-medium">Confirm?</span>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteVersion(v.id)}
                        disabled={deletingId === v.id}
                      >
                        {deletingId === v.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Yes, delete"
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteVersion(v.id)}
                      disabled={deletingId === v.id || v.vetStatus === "PENDING"}
                      title={v.vetStatus === "PENDING" ? "Cannot delete a version under review" : "Delete version"}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>

              {/* The vetting report the platform already recorded for this
                  version. A creator used to see only PASSED/FAILED; the steps,
                  their detail, and the build/probe logs were computed and
                  discarded. */}
              {v.testResults?.steps && v.testResults.steps.length > 0 && (
                <div className="border-t">
                  <button
                    type="button"
                    onClick={() => setOpenReport(openReport === v.id ? null : v.id)}
                    aria-expanded={openReport === v.id}
                    className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-muted-foreground hover:bg-muted/50"
                  >
                    <ChevronDown
                      className={
                        "h-4 w-4 transition-transform " +
                        (openReport === v.id ? "" : "-rotate-90")
                      }
                    />
                    Vetting report
                    <span className="text-xs">
                      ({v.testResults.steps.filter((st) => st.status === "pass").length}/
                      {v.testResults.steps.length} passed)
                    </span>
                  </button>

                  {openReport === v.id && (
                    <div className="space-y-2 border-t bg-muted/20 px-4 py-3">
                      {v.vetNotes && (
                        <p className="text-sm text-muted-foreground">{v.vetNotes}</p>
                      )}
                      {v.testResults.steps.map((st, i) => (
                        <div key={i} className="text-sm">
                          <div className="flex items-center gap-2">
                            <StepIcon status={st.status} />
                            <span className="font-medium">{st.name}</span>
                            {st.detail && (
                              <span className="text-muted-foreground">— {st.detail}</span>
                            )}
                          </div>
                          {st.logLines && st.logLines.length > 0 && (
                            <pre className="mt-1 ml-5 max-h-48 overflow-auto rounded bg-black/80 p-2 text-xs text-gray-100">
                              {st.logLines.join(String.fromCharCode(10))}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
