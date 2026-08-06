"use client";

import { useState, useEffect, useCallback, use } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApprovalCard } from "@/components/marketplace/approval-card";
import { OnboardingPanel } from "@/components/dashboard/onboarding-panel";
import { Loader2, Pause, Play, UserX, RefreshCw, AlertTriangle, ArrowUpCircle, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Capability { name: string; description: string; }
interface Agent {
  name: string;
  slug: string;
  currentVersion: string | null;
  capabilities: Capability[];
}
interface Approval {
  id: string;
  deploymentId: string;
  taskType: string;
  channel: string;
  draft: string;
  reasoning: string;
  originalRequest: string;
  combinedScore: number;
  status: string;
  createdAt: string;
  expiresAt: string;
}
interface Deployment {
  id: string;
  agentName: string;
  agentVersion: string;
  status: string;
  onboardingState: string;
  pauseReason: string | null;
  autoUpdate: boolean;
  agent: Agent;
  _count: { approvals: number };
  updateAvailable: boolean;
  workspaceEmail: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  PROVISIONING: "bg-blue-100 text-blue-800",
  ONBOARDING: "bg-amber-100 text-amber-800",
  ACTIVE: "bg-emerald-100 text-emerald-800",
  PAUSED: "bg-gray-100 text-gray-800",
  FIRED: "bg-red-100 text-red-800",
  ERROR: "bg-red-100 text-red-800",
};

export default function AgentOverviewPage({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = use(params);
  const router = useRouter();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [stats, setStats] = useState({ thisWeek: 0, approvalRate: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [confirmFire, setConfirmFire] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [fireWarning, setFireWarning] = useState<string | null>(null);
  const [review, setReview] = useState<{ rating: number; headline: string; body: string } | null>(null);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewHeadline, setReviewHeadline] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [daysActive, setDaysActive] = useState(0);

  const fetchData = useCallback(async () => {
    try {
      const [depRes, appRes, revRes] = await Promise.all([
        fetch(`/api/deployments/${deploymentId}`),
        fetch(`/api/deployments/${deploymentId}/approvals`),
        fetch(`/api/deployments/${deploymentId}/reviews`),
      ]);
      if (revRes.ok) {
        const revData = await revRes.json();
        const existing = Array.isArray(revData) ? revData[0] : null;
        if (existing) setReview(existing);
      }
      if (depRes.ok) {
        const d = await depRes.json();
        setDeployment(d);
        setDaysActive(Math.floor((Date.now() - new Date(d.createdAt).getTime()) / (1000 * 60 * 60 * 24)));

        // Compute stats from approval history
        if (appRes.ok) {
          const allApprovals: Approval[] = await appRes.json();
          setApprovals(allApprovals.filter((a) => a.status === "PENDING").slice(0, 5));
          const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const thisWeek = allApprovals.filter((a) => new Date(a.createdAt).getTime() > weekAgo).length;
          const resolved = allApprovals.filter((a) => ["APPROVED", "EDITED", "REJECTED"].includes(a.status));
          const approved = resolved.filter((a) => a.status === "APPROVED").length;
          const approvalRate = resolved.length > 0 ? Math.round((approved / resolved.length) * 100) : 0;
          setStats({ thisWeek, approvalRate, total: allApprovals.length });
        }
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [deploymentId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handlePauseResume = async () => {
    if (!deployment) return;
    setActing(true);
    await fetch(`/api/deployments/${deploymentId}/pause`, { method: "POST" });
    await fetchData();
    setActing(false);
    setConfirmPause(false);
  };

  const handleFire = async () => {
    setActing(true);
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/fire`, { method: "POST" });
      const body = await res.json().catch(() => null);
      // Cleanup is queued, not synchronous, and the enqueue can fail. When it does,
      // say so here instead of navigating away as if everything had been removed.
      if (body?.data?.cleanupQueued === false) {
        setConfirmFire(false);
        setActing(false);
        setFireWarning(body.data.cleanupNote ?? "Cleanup could not be started and will run automatically within the hour.");
        return;
      }
    } catch {
      /* The row is already marked FIRED server-side; fall through to the dashboard. */
    }
    router.push("/dashboard");
  };

  const handleResolve = async (
    approvalId: string,
    action: "APPROVED" | "EDITED" | "REJECTED",
    data?: { editedText?: string; rejectionReason?: string },
  ) => {
    await fetch(`/api/deployments/${deploymentId}/approvals/${approvalId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...data }),
    });
    fetchData();
  };

  const handleSubmitReview = async () => {
    if (!reviewHeadline.trim() || !reviewBody.trim()) return;
    setSubmittingReview(true);
    const res = await fetch(`/api/deployments/${deploymentId}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating: reviewRating, headline: reviewHeadline, body: reviewBody }),
    });
    if (res.ok) setReviewSubmitted(true);
    setSubmittingReview(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!deployment) {
    return <p className="text-muted-foreground">Deployment not found.</p>;
  }

  const isPaused = deployment.status === "PAUSED";
  const isActive = deployment.status === "ACTIVE";
  const isFired = deployment.status === "FIRED";
  const isOnboarding = deployment.status === "ONBOARDING";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">{deployment.agentName}</h1>
          <p className="text-sm text-muted-foreground">
            {deployment.agent.name}
            {deployment.agentVersion && (
              <span className="ml-2 font-mono text-xs">v{deployment.agentVersion}</span>
            )}
          </p>
        </div>
        <Badge className={STATUS_COLORS[deployment.status] || ""}>
          {deployment.status}
        </Badge>
      </div>

      {/* Pause reason banner */}
      {isPaused && deployment.pauseReason && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">This agent has been paused</p>
            <p className="mt-0.5 text-amber-700">{deployment.pauseReason}</p>
          </div>
        </div>
      )}

      {/* Update available banner */}
      {deployment.updateAvailable && isActive && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <ArrowUpCircle className="h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p className="font-medium">Update available</p>
            <p className="text-blue-700">
              A new version of this agent is available.{" "}
              {deployment.autoUpdate
                ? "Auto-update is enabled — it will be applied automatically."
                : "Enable auto-update in Settings to apply it automatically."}
            </p>
          </div>
          {!deployment.autoUpdate && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/dashboard/agents/${deploymentId}/settings`}>Settings</Link>
            </Button>
          )}
        </div>
      )}

      {/* Onboarding panel */}
      {isOnboarding && <OnboardingPanel deploymentId={deploymentId} />}

      {/* Stats */}
      {!isOnboarding && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Tasks This Week</p>
              <p className="text-2xl font-bold">{stats.thisWeek}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Approval Rate</p>
              <p className="text-2xl font-bold">{stats.approvalRate}%</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-sm text-muted-foreground">Total Actions</p>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Pending approvals (up to 5) */}
      {approvals.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">
              Pending Approvals
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({approvals.length} shown)
              </span>
            </h2>
            <Button variant="ghost" size="sm" asChild>
              <Link href={`/dashboard/agents/${deploymentId}/approvals`}>
                View all
              </Link>
            </Button>
          </div>
          <div className="space-y-3">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                isFocused={false}
                onResolve={(id, action, data) => handleResolve(id, action, data)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Review */}
      {isActive && daysActive >= 14 && !review && !reviewSubmitted && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Leave a Review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <button key={s} onClick={() => setReviewRating(s)} type="button">
                  <Star className={`h-5 w-5 ${s <= reviewRating ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
                </button>
              ))}
            </div>
            <Input
              placeholder="Headline (e.g. Saved us 10 hours a week)"
              value={reviewHeadline}
              onChange={(e) => setReviewHeadline(e.target.value)}
            />
            <Textarea
              placeholder="Tell others about your experience..."
              rows={3}
              value={reviewBody}
              onChange={(e) => setReviewBody(e.target.value)}
            />
            <Button size="sm" onClick={handleSubmitReview} disabled={submittingReview || !reviewHeadline.trim() || !reviewBody.trim()}>
              {submittingReview ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
              Submit Review
            </Button>
          </CardContent>
        </Card>
      )}
      {reviewSubmitted && (
        <p className="text-sm text-emerald-600 font-medium">Thanks for your review!</p>
      )}

      {/* Action buttons */}
      {!isFired && !isOnboarding && (
        <div className="flex items-center gap-2 flex-wrap border-t pt-4">
          <Button
            variant="outline"
            onClick={() => (isPaused ? handlePauseResume() : setConfirmPause(true))}
            disabled={acting || deployment.status === "PROVISIONING"}
          >
            {acting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : isPaused ? (
              <Play className="mr-2 h-4 w-4" />
            ) : (
              <Pause className="mr-2 h-4 w-4" />
            )}
            {isPaused ? "Resume" : "Pause"}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setLoading(true); fetchData(); }}
            disabled={acting}
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmFire(true)}
            >
              <UserX className="mr-1 h-4 w-4" />
              Fire agent
            </Button>
          </div>
        </div>
      )}

      <Dialog open={confirmPause} onOpenChange={(open) => { if (!open) setConfirmPause(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pause className="h-5 w-5" />
              Pause {deployment?.agentName}?
            </DialogTitle>
            <DialogDescription>
              Your agent stops working immediately and keeps everything it has.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="font-medium">
                You will be charged half the monthly rate while paused.
              </p>
              <p className="mt-1 text-muted-foreground">
                Its Microsoft 365 licence seat, mailbox address and stored files are
                held for you the whole time it is paused, so it comes back as the
                same colleague with its history intact rather than as a new hire.
              </p>
            </div>

            <div>
              <p className="font-medium mb-2">While paused</p>
              <ul className="space-y-1.5 text-muted-foreground list-disc pl-5">
                <li>It stops reading email and stops acting</li>
                <li>Its mailbox, files and approval history are kept</li>
                <li>Resuming brings it back with the same address</li>
              </ul>
            </div>

            <p className="text-muted-foreground">
              To stop paying entirely, fire the agent instead — that deletes its
              account, mailbox and files permanently.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPause(false)} disabled={acting}>
              Keep running
            </Button>
            <Button onClick={handlePauseResume} disabled={acting}>
              {acting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Pause className="mr-2 h-4 w-4" />}
              Pause at half rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmFire} onOpenChange={(open) => { if (!open) setConfirmFire(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Fire {deployment?.agentName}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the agent&apos;s identity in your Microsoft 365
              tenant. It cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium mb-2">Deleted permanently</p>
              <ul className="space-y-1.5 text-muted-foreground list-disc pl-5">
                <li>
                  The agent&apos;s Microsoft 365 account
                  {deployment?.workspaceEmail ? (
                    <>
                      {" — "}
                      <span className="font-mono text-xs text-foreground break-all">
                        {deployment.workspaceEmail}
                      </span>
                    </>
                  ) : null}
                </li>
                <li>Its mailbox, and every email it has sent or received</li>
                <li>Its OneDrive and any files stored there</li>
                <li>The running agent and its isolated network</li>
              </ul>
            </div>

            <div>
              <p className="font-medium mb-2">Released back to you</p>
              <ul className="space-y-1.5 text-muted-foreground list-disc pl-5">
                <li>
                  Its Microsoft 365 licence seat, free for another agent or employee
                </li>
                <li>
                  Billing stops at the end of the current period — you keep access until then
                </li>
              </ul>
            </div>

            <div>
              <p className="font-medium mb-2">Kept</p>
              <ul className="space-y-1.5 text-muted-foreground list-disc pl-5">
                <li>Files in the shared SharePoint folder, which is not deleted</li>
                <li>This agent&apos;s approval history, kept for your records</li>
              </ul>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" onClick={() => setConfirmFire(false)} disabled={acting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleFire} disabled={acting}>
              {acting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Fire agent permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={fireWarning !== null} onOpenChange={(open) => { if (!open) setFireWarning(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Agent fired — cleanup delayed
            </DialogTitle>
            <DialogDescription>{fireWarning}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => { setFireWarning(null); router.push("/dashboard"); }}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
