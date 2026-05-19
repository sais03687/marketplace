"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2 } from "lucide-react";

interface Props {
  slug: string;
  agentName: string;
}

export function DeleteAgentButton({ slug, agentName }: Props) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/agents/${slug}`, { method: "DELETE" });
      if (res.ok) {
        router.refresh();
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Delete failed");
        setConfirm(false);
      }
    } catch {
      setError("Network error");
      setConfirm(false);
    }

    setDeleting(false);
  };

  if (confirm) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-xs text-red-600 font-medium">
          Delete &ldquo;{agentName}&rdquo;? This pauses all active deployments.
        </p>
        <div className="flex gap-1">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : "Confirm delete"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setConfirm(false); setError(null); }}
            disabled={deleting}
          >
            Cancel
          </Button>
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-destructive"
      onClick={handleDelete}
    >
      <Trash2 className="mr-1 h-3 w-3" />
      Delete
    </Button>
  );
}
