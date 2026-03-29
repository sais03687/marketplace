import { cn } from "@/lib/utils";

interface RiskScoreBadgeProps {
  score: number;
  className?: string;
}

export function RiskScoreBadge({ score, className }: RiskScoreBadgeProps) {
  const rounded = Math.round(score * 10) / 10;

  let color: string;
  let label: string;
  if (rounded <= 3) {
    color = "bg-emerald-100 text-emerald-800";
    label = "Low";
  } else if (rounded <= 6) {
    color = "bg-amber-100 text-amber-800";
    label = "Medium";
  } else {
    color = "bg-red-100 text-red-800";
    label = "High";
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        color,
        className,
      )}
    >
      {rounded}
      <span className="text-[10px] opacity-75">{label}</span>
    </span>
  );
}
