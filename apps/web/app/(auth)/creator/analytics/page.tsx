"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Users, DollarSign, TrendingUp, Loader2 } from "lucide-react";
import { formatPrice } from "@/lib/utils";

interface AnalyticsData {
  totalDeployments: number;
  activeDeployments: number;
  mrr: number;
  approvalRate: number;
  totalApprovals: number;
  perAgent: Array<{
    slug: string;
    name: string;
    activeDeployments: number;
    totalDeployments: number;
    mrr: number;
    approvalCount: number;
  }>;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/creator/analytics")
      .then((res) => res.json())
      .then(setData)
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
      </div>

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
