import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

const STAGES = [
  { key: "INTERVIEW", label: "Interview" },
  { key: "OBSERVATION", label: "Observation" },
  { key: "INTRODUCTION", label: "Introduction" },
  { key: "LIVE", label: "Live" },
] as const;

interface OnboardingProgressProps {
  currentStage: string;
  className?: string;
}

export function OnboardingProgress({
  currentStage,
  className,
}: OnboardingProgressProps) {
  const currentIndex = STAGES.findIndex((s) => s.key === currentStage);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {STAGES.map((stage, i) => {
        const isComplete = i < currentIndex;
        const isCurrent = i === currentIndex;

        return (
          <div key={stage.key} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={cn(
                  "h-px w-8",
                  isComplete ? "bg-primary" : "bg-border",
                )}
              />
            )}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium",
                  isComplete && "bg-primary text-primary-foreground",
                  isCurrent && "border-2 border-primary text-primary",
                  !isComplete && !isCurrent && "border border-border text-muted-foreground",
                )}
              >
                {isComplete ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <span
                className={cn(
                  "text-[10px]",
                  isCurrent ? "font-semibold text-primary" : "text-muted-foreground",
                )}
              >
                {stage.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
