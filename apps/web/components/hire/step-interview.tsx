"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { useHire } from "@/lib/hire-context";
import {
  PLATFORM_QUESTIONS,
  mergeWithPlatformQuestions,
  type OnboardingQuestion,
} from "@/lib/platform-questions";

export function StepInterview() {
  const { state, updateState, setStep } = useHire();
  const [questions, setQuestions] = useState<OnboardingQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>(
    state.onboardingAnswers,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchQuestions() {
      try {
        const res = await fetch(`/api/agents/${state.agentSlug}`);
        if (res.ok) {
          const agent = await res.json();
          setQuestions(mergeWithPlatformQuestions(agent.onboardingQuestions));
        } else {
          // Fall back to platform questions only
          setQuestions(mergeWithPlatformQuestions(null));
        }
      } catch {
        setQuestions(mergeWithPlatformQuestions(null));
      }
      setLoading(false);
    }
    fetchQuestions();
  }, [state.agentSlug]);

  const sortedQuestions = [...questions].sort(
    (a, b) => (a.order ?? 99) - (b.order ?? 99),
  );

  const requiredUnanswered = sortedQuestions.filter(
    (q) => q.required && !(answers[q.id] ?? q.default ?? "").trim(),
  );

  const handleContinue = () => {
    // Merge in defaults for questions the user didn't interact with
    const merged: Record<string, string> = {};
    for (const q of sortedQuestions) {
      const value = answers[q.id] ?? q.default ?? "";
      if (value) merged[q.id] = value;
    }
    updateState({ onboardingAnswers: merged });
    setStep(6);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Answer a few quick questions so{" "}
          <span className="font-medium text-foreground">{state.hireName}</span>{" "}
          can start working effectively from day one.
        </p>
      </div>

      <div className="max-h-[380px] overflow-y-auto space-y-3 pr-1">
        {sortedQuestions.map((q) => {
          const currentValue = answers[q.id] ?? q.default ?? "";
          return (
            <Card key={q.id}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="text-sm font-medium leading-snug">
                    {q.question}
                  </span>
                  {q.required && (
                    <Badge
                      variant="outline"
                      className="shrink-0 text-[10px] mt-0.5"
                    >
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
                            setAnswers((prev) => ({
                              ...prev,
                              [q.id]: opt.value,
                            }))
                          }
                          className="mt-0.5 shrink-0"
                        />
                        <span className="text-sm">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <Textarea
                    value={currentValue}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [q.id]: e.target.value,
                      }))
                    }
                    placeholder="Type your answer... (optional)"
                    rows={2}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={() => setStep(4)}>
          Back
        </Button>
        <Button
          className="flex-1"
          onClick={handleContinue}
          disabled={requiredUnanswered.length > 0}
        >
          Review & Hire
        </Button>
      </div>
    </div>
  );
}
