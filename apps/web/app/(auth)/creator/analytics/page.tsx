"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Users, DollarSign, TrendingUp, Loader2, Wallet } from "lucide-react";
import { formatPrice } from "@/lib/utils";
import Link from "next/link";

interface Outcomes {
  approved: number;
  edited: number;
  rejected: number;
  expired: number;
  pending: number;
}

interface AnalyticsData {
  totalDeployments: number;
  activeDeployments: number;
  mrr: number;
  approvalRate: number;
  totalApprovals: number;
  outcomes: Outcomes;
  perAgent: Array<{
    slug: string;
    name: string;
    activeDeployments: number;
    totalDeployments: number;
    mrr: number;
    approvalCount: number;
    outcomes: Outcomes;
    topRejectedTasks: Array<{ taskType: string; count: number }>;
  }>;
}

interface PayoutSummary {
  totalPaidCents: number;
  totalPaidDollars: string;
  payouts: Array<{
    id: string;
    periodStart: string;
    creatorShareCents: number;
    status: string;
  }>;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [payoutData, setPayoutData] = useState<PayoutSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/creator/analytics").then((r) => r.json()),
      fetch("/api/creator/payouts").then((r) => r.json()).catch(() => null),
    ])
      .then(([analytics, payouts]) => {
        setData(analytics);
        setPayoutData(payouts);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-muted-foreground">Failed to load analytics data.</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Analytics</h1>
      <p className="text-muted-foreground">
        Performance metrics for your published agents.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Active Deployments
              </span>
            </div>
            <p className="mt-2 text-2xl font-bold">{data.activeDeployments}</p>
            <p className="text-xs text-muted-foreground">
              {data.totalDeployments} total
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">MRR</span>
            </div>
            <p className="mt-2 text-2xl font-bold">{formatPrice(data.mrr)}</p>
            <p className="text-xs text-muted-foreground">Monthly recurring</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Approval Rate
              </span>
            </div>
            <p className="mt-2 text-2xl font-bold">
              {data.totalApprovals > 0
                ? `${Math.round(data.approvalRate * 100)}%`
                : "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.totalApprovals} total approvals
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Agents
              </span>
            </div>
            <p className="mt-2 text-2xl font-bold">{data.perAgent.length}</p>
            <p className="text-xs text-muted-foreground">Published</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Earned</span>
            </div>
            <p className="mt-2 text-2xl font-bold">
              {payoutData ? `$${payoutData.totalPaidDollars}` : "—"}
            </p>
            <p className="text-xs text-muted-foreground">All-time payouts</p>
          </CardContent>
        </Card>
      </div>

      {/* How buyers respond — the quality feedback loop. Approved / edited /
          rejected / expired across all deployments. Aggregate only: no buyer
          text ever reaches the creator, only counts of how their agents' actions
          landed. */}
      {data.outcomes && (data.outcomes.approved + data.outcomes.edited + data.outcomes.rejected + data.outcomes.expired) > 0 && (
        <Card className="mt-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">How buyers respond to your agents</CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const o = data.outcomes;
              const decided = o.approved + o.edited + o.rejected;
              const seg = (n: number) => (decided > 0 ? `${(n / decided) * 100}%` : "0%");
              return (
                <>
                  <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
                    <div className="bg-green-500" style={{ width: seg(o.approved) }} title={`Approved: ${o.approved}`} />
                    <div className="bg-amber-500" style={{ width: seg(o.edited) }} title={`Edited: ${o.edited}`} />
                    <div className="bg-red-500" style={{ width: seg(o.rejected) }} title={`Rejected: ${o.rejected}`} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-green-500" /> Approved <b>{o.approved}</b></span>
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Edited <b>{o.edited}</b></span>
                    <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500" /> Rejected <b>{o.rejected}</b></span>
                    {o.expired > 0 && (
                      <span className="flex items-center gap-1.5 text-muted-foreground"><span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/40" /> Expired <b>{o.expired}</b></span>
                    )}
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    Edited means a buyer sent your agent&apos;s action after changing it; rejected means they declined it.
                    A high edit or reject rate on a task type is a sign the agent&apos;s output needs work.
                    {o.expired > 0 && " Expired approvals timed out unanswered — often a sign the agent asks too often."}
                  </p>
                </>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Recent payouts summary */}
      {payoutData?.payouts && payoutData.payouts.length > 0 && (
        <Card className="mt-6">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base">Recent Payouts</CardTitle>
            <Link href="/creator/payouts" className="text-xs text-muted-foreground underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {payoutData.payouts.slice(0, 3).map((p) => (
                <div key={p.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {new Date(p.periodStart).toLocaleString("default", { month: "long", year: "numeric" })}
                  </span>
                  <span className="font-medium">{formatPrice(p.creatorShareCents)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data.perAgent.length > 0 && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-base">Per-Agent Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Agent</th>
                    <th className="pb-2 font-medium text-right">Active</th>
                    <th className="pb-2 font-medium text-right">Total</th>
                    <th className="pb-2 font-medium text-right">MRR</th>
                    <th className="pb-2 font-medium text-right">Approvals</th>
                    <th className="pb-2 font-medium text-right">Edited</th>
                    <th className="pb-2 font-medium text-right">Rejected</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perAgent.map((agent) => (
                    <tr key={agent.slug} className="border-b last:border-0">
                      <td className="py-2">
                        <span className="font-medium">{agent.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {agent.slug}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {agent.activeDeployments}
                      </td>
                      <td className="py-2 text-right">
                        {agent.totalDeployments}
                      </td>
                      <td className="py-2 text-right">
                        {formatPrice(agent.mrr)}
                      </td>
                      <td className="py-2 text-right">
                        {agent.approvalCount}
                      </td>
                      <td className="py-2 text-right">
                        {agent.outcomes?.edited
                          ? <span className="text-amber-600">{agent.outcomes.edited}</span>
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className="py-2 text-right">
                        {agent.outcomes?.rejected
                          ? <span className="text-red-600">{agent.outcomes.rejected}</span>
                          : <span className="text-muted-foreground">0</span>}
                        {agent.topRejectedTasks && agent.topRejectedTasks.length > 0 && (
                          <div className="text-xs font-normal text-muted-foreground">
                            {agent.topRejectedTasks.map((t) => `${t.taskType} (${t.count})`).join(", ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
