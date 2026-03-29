import { cn } from "@/lib/utils";

interface TrustScoreBarProps {
  score: number; // 0-1
  autonomyLevel: string;
  className?: string;
}

const AUTONOMY_LABELS: Record<string, string> = {
  always_queue: "Always Queue",
  queue_if_stakes_gt_5: "Queue if Stakes > 5",
  queue_if_stakes_gt_7: "Queue if Stakes > 7",
  auto_execute: "Auto Execute",
};

export function TrustScoreBar({
  score,
  autonomyLevel,
  className,
}: TrustScoreBarProps) {
  const percent = Math.round(score * 100);

  let barColor: string;
  if (percent >= 80) barColor = "bg-emerald-500";
  else if (percent >= 60) barColor = "bg-amber-500";
  else barColor = "bg-red-500";

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{percent}% approval rate</span>
        <span className="text-muted-foreground">
          {AUTONOMY_LABELS[autonomyLevel] || autonomyLevel}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
