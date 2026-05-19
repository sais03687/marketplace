"use client";

import { useState, useEffect, useCallback, use } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Upload, ArrowLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/utils";

interface AgentVersion {
  id: string;
  version: string;
  vetStatus: string;
  changelog: string | null;
  publishedAt: string | null;
  createdAt: string;
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
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
