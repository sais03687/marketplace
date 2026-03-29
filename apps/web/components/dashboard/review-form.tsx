"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Star, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReviewFormProps {
  deploymentId: string;
  agentName: string;
  canReview: boolean;
  daysRemaining?: number;
}

export function ReviewForm({
  deploymentId,
  agentName,
  canReview,
  daysRemaining,
}: ReviewFormProps) {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (rating === 0 || !headline.trim() || !body.trim()) return;
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch(`/api/deployments/${deploymentId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, headline, body }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to submit review");
      }

      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }

    setSubmitting(false);
  };

  if (submitted) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-5">
          <Check className="h-5 w-5 text-emerald-500" />
          <p className="font-medium">Review submitted. Thank you!</p>
        </CardContent>
      </Card>
    );
  }

  if (!canReview) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted-foreground">
            You can leave a review for {agentName} in {daysRemaining ?? 0}{" "}
            days.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          How is {agentName} doing?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setRating(n)}
              onMouseEnter={() => setHoverRating(n)}
              onMouseLeave={() => setHoverRating(0)}
            >
              <Star
                className={cn(
                  "h-6 w-6",
                  n <= (hoverRating || rating)
                    ? "fill-amber-400 text-amber-400"
                    : "text-muted",
                )}
              />
            </button>
          ))}
        </div>

        <Input
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder="Headline (e.g. 'Saves me 10 hours a week')"
        />

        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Share your experience..."
          rows={3}
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button
          onClick={handleSubmit}
          disabled={submitting || rating === 0 || !headline.trim() || !body.trim()}
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Submit Review
        </Button>
      </CardContent>
    </Card>
  );
}
