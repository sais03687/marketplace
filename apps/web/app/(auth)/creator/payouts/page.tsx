"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DollarSign, ExternalLink, Loader2 } from "lucide-react";
import { formatPrice } from "@/lib/utils";

interface Payout {
  id: string;
  periodStart: string;
  periodEnd: string;
  grossRevenueCents: number;
  platformFeeCents: number;
  creatorShareCents: number;
  status: string;
  paidAt: string | null;
}

interface PayoutsData {
  payouts: Payout[];
  totalPaidCents: number;
  totalPaidDollars: string;
}

interface StripeStatus {
  stripeOnboarded: boolean;
  creatorSharePercent: number;
  platformSharePercent: number;
}

function payoutBadge(status: string) {
  if (status === "PAID") return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Paid</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

function formatPeriod(start: string) {
  return new Date(start).toLocaleString("default", { month: "long", year: "numeric" });
}

export default function PayoutsPage() {
  const [payouts, setPayouts] = useState<PayoutsData | null>(null);
  const [stripeStatus, setStripeStatus] = useState<StripeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/creator/payouts").then((r) => r.json()),
      fetch("/api/creator/stripe/connect").then((r) => r.json()).catch(() => null),
    ])
      .then(([p, s]) => {
        setPayouts(p);
        setStripeStatus(s);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch("/api/creator/stripe/connect", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error || "Failed to start Stripe onboarding. Please try again.");
      }
    } catch {
      alert("Network error — please try again.");
    }
    setConnecting(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const creatorShare = stripeStatus?.creatorSharePercent ?? 70;
  const platformShare = stripeStatus?.platformSharePercent ?? 30;

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold">Payouts</h1>
      <p className="text-muted-foreground">
        Your earnings from agent subscriptions.
      </p>

      {/* Stripe Connect */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4" />
            Stripe Connect
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stripeStatus?.stripeOnboarded ? (
            <div className="flex items-center gap-2 text-sm">
              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Connected</Badge>
              <span className="text-muted-foreground">
                Payouts sent directly to your bank account on the 1st of each month.
              </span>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-4">
                Connect your Stripe account to receive monthly payouts. Platform fee: {platformShare}% — you keep {creatorShare}%.
              </p>
              <div className="rounded-lg bg-muted p-4 text-sm space-y-1 mb-4">
                <p className="font-medium">Fee Schedule</p>
                <p className="text-muted-foreground">Under $200/mo: 30% platform fee</p>
                <p className="text-muted-foreground">$200–$500/mo: 25% platform fee</p>
                <p className="text-muted-foreground">Above $500/mo: 20% platform fee</p>
              </div>
              <Button onClick={handleConnect} disabled={connecting}>
                {connecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <ExternalLink className="mr-2 h-4 w-4" />
                Connect Stripe Account
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Total earned */}
      {payouts && payouts.totalPaidCents > 0 && (
        <Card className="mt-4">
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">Total Earned</p>
            <p className="mt-1 text-3xl font-bold">${payouts.totalPaidDollars}</p>
          </CardContent>
        </Card>
      )}

      {/* Payout history */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Payout History</CardTitle>
        </CardHeader>
        <CardContent>
          {!payouts?.payouts?.length ? (
            <p className="text-sm text-muted-foreground">
              No payouts yet. Payouts are processed on the 1st of each month after your agent has active subscribers.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Period</th>
                    <th className="pb-2 font-medium text-right">Gross</th>
                    <th className="pb-2 font-medium text-right">Fee</th>
                    <th className="pb-2 font-medium text-right">Your Share</th>
                    <th className="pb-2 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.payouts.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2">{formatPeriod(p.periodStart)}</td>
                      <td className="py-2 text-right">{formatPrice(p.grossRevenueCents)}</td>
                      <td className="py-2 text-right text-muted-foreground">
                        -{formatPrice(p.platformFeeCents)}
                      </td>
                      <td className="py-2 text-right font-medium">
                        {formatPrice(p.creatorShareCents)}
                      </td>
                      <td className="py-2 text-right">{payoutBadge(p.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
