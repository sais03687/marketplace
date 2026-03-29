"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CreditCard, ExternalLink } from "lucide-react";

export default function BillingPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold">Billing</h1>
      <p className="text-muted-foreground">
        Manage your subscriptions and payment methods.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Payment Method
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Billing is not yet configured. When ready, you&apos;ll manage your
            payment methods through Stripe.
          </p>
          <Button className="mt-4" variant="outline" disabled>
            <ExternalLink className="mr-2 h-4 w-4" />
            Manage in Stripe
          </Button>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Active Subscriptions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No active subscriptions. Hire an AI employee to get started.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
