"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Clock, CheckCircle2 } from "lucide-react";

/**
 * The creator access request flow, shown to anyone who is not yet an approved
 * creator. Publishing is invite-gated during the beta: you request access, an
 * admin reaches out and approves or denies. "none" = never asked, "PENDING" =
 * under review, "DENIED" = declined (resubmittable).
 */
export function CreatorAccessGate({
  status,
  displayName,
  email,
  note,
}: {
  status: string;
  displayName: string;
  email: string;
  note: string;
}) {
  const [state, setState] = useState(status);

  if (state === "PENDING") {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <Clock className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-4 text-xl font-semibold">Your request is under review</h2>
        <p className="mt-2 text-muted-foreground">
          Thanks for asking to build on the marketplace. We&apos;ll reach out at{" "}
          <span className="font-medium">{email}</span> and you&apos;ll be able to publish once
          you&apos;re approved.
        </p>
      </div>
    );
  }

  return <RequestForm initialName={displayName} initialEmail={email} initialNote={note} status={state} onDone={setState} />;
}

function RequestForm({
  initialName,
  initialEmail,
  initialNote,
  status,
  onDone,
}: {
  initialName: string;
  initialEmail: string;
  initialNote: string;
  status: string;
  onDone: (s: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/creator/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, email, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not submit your request.");
        return;
      }
      onDone(data.status ?? "PENDING");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg py-12">
      <h2 className="text-xl font-semibold">Build on the Marketplace</h2>
      <p className="mt-2 text-muted-foreground">
        Creator access is invite-only during the beta. Tell us a little about yourself and what
        you want to build — we&apos;ll review it and get back to you by email.
      </p>

      {status === "DENIED" && (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Your previous request wasn&apos;t approved. You&apos;re welcome to update the details
          below and resubmit.
        </p>
      )}

      <Card className="mt-6">
        <CardContent className="space-y-4 p-5">
          <div>
            <label className="text-sm font-medium">Your name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jordan Lee"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Contact email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jordan@company.com"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">
              What do you want to build? <span className="text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="A data-analysis agent for finance teams…"
              rows={4}
              className="mt-1"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={submit} disabled={busy || !name.trim() || !email.trim()}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Submitting…
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Request access
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
