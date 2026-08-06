"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CreditCard, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { formatPrice } from "@/lib/utils";

interface Subscription {
  deploymentId: string;
  agentName: string;
  agentSlug: string;
  pricePerMonth: number | null;
  status: string;
  subscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

function statusBadge(status: string, cancelAtPeriodEnd: boolean) {
  if (cancelAtPeriodEnd) return <Badge variant="outline">Cancels at period end</Badge>;
  if (status === "ACTIVE") return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Active</Badge>;
  if (status === "PAUSED") return <Badge variant="secondary">Paused</Badge>;
  if (status === "ONBOARDING") return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">Onboarding</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

export default function BillingPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  const fetchBilling = () => {
    fetch("/api/company/billing")
      .then((r) => r.json())
      .then((d) => setSubscriptions(d.subscriptions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchBilling(); }, []);

  const handleCancel = async (subscriptionId: string) => {
    // Cancelling is destructive, just not immediately, and that delay is exactly
    // what made the old one-line confirm misleading: it said the agent stays
    // active until the period ends and stopped there. What it did not say is what
    // happens next. At period end Stripe emits customer.subscription.deleted, and
    // the webhook sets the deployment FIRED and enqueues a full deprovision —
    // Microsoft identity deleted, mailbox and its history gone, data volume
    // removed. The same end state as the Fire button, which by contrast spells all
    // of that out before you confirm.
    if (
      !confirm(
        "Cancel this subscription?" +
          "\n\n" +
          "Your agent keeps working until the end of the current billing period. " +
          "After that it is permanently deleted — its Microsoft 365 account and " +
          "mailbox, every email it has sent or received, its files and its licence " +
          "seat." +
          "\n\n" +
          "This cannot be undone once the period ends. To keep the agent and its " +
          "data while stopping its work, pause it instead — paused agents are " +
          "charged at half rate.",
      )
    )
      return;
    setCancelling(subscriptionId);
    try {
      await fetch("/api/company/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId }),
      });
      fetchBilling();
    } catch {
      // ignore
    }
    setCancelling(null);
  };

  const handleManageBilling = async () => {
    setOpeningPortal(true);
    try {
      const res = await fetch("/api/company/billing/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      // ignore
    }
    setOpeningPortal(false);
  };

  const pausedSubs = subscriptions.filter((s) => s.status === "PAUSED");

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-muted-foreground">Manage your agent subscriptions.</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleManageBilling} disabled={openingPortal}>
          {openingPortal ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="mr-2 h-4 w-4" />
          )}
          Manage payment method
        </Button>
      </div>

      {pausedSubs.length > 0 && (
        <Alert variant="destructive" className="mt-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>
              {pausedSubs.length === 1
                ? `${pausedSubs[0].agentName} has been paused due to a failed payment.`
                : `${pausedSubs.length} agents have been paused due to failed payments.`}{" "}
              Update your payment method to resume.
            </span>
            <Button
              size="sm"
              variant="destructive"
              className="ml-4 shrink-0"
              onClick={handleManageBilling}
              disabled={openingPortal}
            >
              {openingPortal && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Update card
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Active Subscriptions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          ) : subscriptions.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <AlertCircle className="h-4 w-4" />
              No active subscriptions. <a href="/browse" className="underline ml-1">Browse agents</a> to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 font-medium">Agent</th>
                    <th className="pb-2 font-medium">Price</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Next Billing</th>
                    <th className="pb-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((sub) => (
                    <tr key={sub.deploymentId} className="border-b last:border-0">
                      <td className="py-3 font-medium">{sub.agentName}</td>
                      <td className="py-3">
                        {sub.pricePerMonth != null
                          ? `${formatPrice(sub.pricePerMonth)}/mo`
                          : "—"}
                      </td>
                      <td className="py-3">
                        {statusBadge(sub.status, sub.cancelAtPeriodEnd)}
                      </td>
                      <td className="py-3 text-muted-foreground">
                        {sub.currentPeriodEnd
                          ? new Date(sub.currentPeriodEnd).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="py-3 text-right">
                        {!sub.cancelAtPeriodEnd && sub.subscriptionId && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={cancelling === sub.subscriptionId}
                            onClick={() => handleCancel(sub.subscriptionId!)}
                          >
                            {cancelling === sub.subscriptionId && (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            )}
                            Cancel
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-4 text-xs text-muted-foreground">
        Subscriptions are billed monthly. Cancellations take effect at the end of the current billing period.
        Paused agents are charged at 50% of the monthly rate.
      </p>
    </div>
  );
}
