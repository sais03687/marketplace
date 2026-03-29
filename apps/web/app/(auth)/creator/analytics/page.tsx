"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Users, DollarSign, TrendingUp } from "lucide-react";

export default function AnalyticsPage() {
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
            <p className="mt-2 text-2xl font-bold">0</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">MRR</span>
            </div>
            <p className="mt-2 text-2xl font-bold">$0</p>
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
            <p className="mt-2 text-2xl font-bold">—</p>
            <p className="text-xs text-muted-foreground">Aggregate, anonymized</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Version Adoption
              </span>
            </div>
            <p className="mt-2 text-2xl font-bold">—</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle className="text-base">Deployment Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-48 items-center justify-center text-muted-foreground">
            Charts will appear once you have active deployments.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
