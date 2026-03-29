"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DollarSign, ExternalLink } from "lucide-react";

export default function PayoutsPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold">Payouts</h1>
      <p className="text-muted-foreground">
        Set up Stripe Connect to receive earnings from your agents.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4" />
            Stripe Connect
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Connect your Stripe account to receive monthly payouts from agent
            subscriptions. Platform fees are deducted automatically.
          </p>
          <div className="rounded-lg bg-muted p-4 text-sm space-y-1">
            <p className="font-medium">Platform Fee Schedule:</p>
            <p className="text-muted-foreground">Under $200/mo: 30% platform fee</p>
            <p className="text-muted-foreground">$200-$500/mo: 25% platform fee</p>
            <p className="text-muted-foreground">Above $500/mo: 20% platform fee</p>
          </div>
          <Button className="mt-4" disabled>
            <ExternalLink className="mr-2 h-4 w-4" />
            Connect Stripe Account
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Payout History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No payouts yet. Payouts are processed monthly after your agent has
            active subscribers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
