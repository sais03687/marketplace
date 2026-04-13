"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

interface QuestionOption {
  value: string;
  label: string;
}

interface Question {
  id: string;
  order: number;
  question: string;
  memoryKey: string;
  required: boolean;
  followUp?: string;
  type?: "text" | "choice";
  options?: QuestionOption[];
  default?: string;
}

interface OnboardingInterviewProps {
  deploymentId: string;
  questions: Question[];
  onComplete: () => void;
}

export function OnboardingInterview({
  deploymentId,
  questions,
  onComplete,
}: OnboardingInterviewProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedQuestions = [...questions].sort((a, b) => a.order - b.order);

  const requiredUnanswered = sortedQuestions.filter(
    (q) => q.required && !(answers[q.id] ?? q.default ?? "").trim(),
  );

  const handleSubmit = async () => {
    if (requiredUnanswered.length > 0) {
      setError("Please answer all required questions.");
      return;
    }

    setSubmitting(true);
    setError(null);

    // Merge defaults for any question the user didn't actively interact with
    // so structured-choice defaults get persisted server-side.
    const mergedAnswers: Record<string, string> = {};
    for (const q of sortedQuestions) {
      const value = answers[q.id] ?? q.default ?? "";
      if (value) mergedAnswers[q.id] = value;
    }

    try {
      const res = await fetch(`/api/deployments/${deploymentId}/onboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: mergedAnswers }),
      });

      if (res.ok) {
        onComplete();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Failed to submit answers");
      }
    } catch {
      setError("Network error. Please try again.");
    }

    setSubmitting(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Onboarding Interview</h3>
        <p className="text-sm text-muted-foreground">
          Answer these questions to help your agent get started. Your answers
          will be used to configure the agent&apos;s knowledge base.
        </p>
      </div>

      {sortedQuestions.map((q) => {
        const currentValue = answers[q.id] ?? q.default ?? "";
        return (
          <Card key={q.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{q.question}</span>
                {q.required && (
                  <Badge variant="outline" className="text-[10px]">
                    Required
                  </Badge>
                )}
              </div>
              {q.type === "choice" && q.options ? (
                <div className="space-y-2">
                  {q.options.map((opt) => (
                    <label
                      key={opt.value}
                      className="flex items-start gap-2 cursor-pointer rounded border p-2 hover:bg-accent/40"
                    >
                      <input
                        type="radio"
                        name={q.id}
                        value={opt.value}
                        checked={currentValue === opt.value}
                        onChange={() =>
                          setAnswers({ ...answers, [q.id]: opt.value })
                        }
                        className="mt-0.5"
                      />
                      <span className="text-sm">{opt.label}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Textarea
                  value={currentValue}
                  onChange={(e) =>
                    setAnswers({ ...answers, [q.id]: e.target.value })
                  }
                  placeholder="Type your answer..."
                  rows={3}
                />
              )}
            </CardContent>
          </Card>
        );
      })}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <Button
        onClick={handleSubmit}
        disabled={submitting || requiredUnanswered.length > 0}
        className="w-full"
      >
        {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Submit Answers & Continue
      </Button>
    </div>
  );
}
