"use client";

export interface WorksWithOption {
  id: string;
  name: string;
  agent: string;
  status: string;
}

/**
 * "Which of your agents should this one work with?" — a checkbox per hire.
 *
 * Used by the hire wizard and by an agent's Settings. Chosen agents are told
 * about each other and may email each other; the rest never hear of it.
 */
export function WorksWithPicker({
  options,
  selected,
  onChange,
  disabled,
}: {
  options: WorksWithOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  if (options.length === 0) {
    return <p className="text-sm text-muted-foreground">You haven&apos;t hired any other agents yet.</p>;
  }
  return (
    <div className="space-y-2">
      {options.map((o) => {
        const checked = selected.includes(o.id);
        return (
          <label key={o.id} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(checked ? selected.filter((id) => id !== o.id) : [...selected, o.id])}
            />
            <span className="flex-1">
              <span className="font-medium">{o.name}</span>
              <span className="text-muted-foreground"> · {o.agent}</span>
            </span>
            {o.status !== "ACTIVE" && (
              <span className="text-xs text-muted-foreground">{o.status.toLowerCase()}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
