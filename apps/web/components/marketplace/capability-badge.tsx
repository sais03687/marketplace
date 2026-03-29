import { cn } from "@/lib/utils";

interface CapabilityBadgeProps {
  name: string;
  className?: string;
}

export function CapabilityBadge({ name, className }: CapabilityBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700",
        className,
      )}
    >
      {name}
    </span>
  );
}
