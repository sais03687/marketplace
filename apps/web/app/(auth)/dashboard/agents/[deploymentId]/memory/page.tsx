"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Download, AlertCircle } from "lucide-react";

interface MemoryEntry {
  key: string;
  value: string;
  updatedAt?: string;
}

export default function MemoryPage() {
  const params = useParams();
  const deploymentId = params.deploymentId as string;
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}/memory`)
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json();
          setError(data.error || "Failed to load memory");
          setLoading(false);
          return;
        }
        const data = await r.json();
        if (data.memory === null) {
          setError(data.message || "No memory available");
        } else if (typeof data === "object" && data.entries) {
          setMemory(data.entries);
        } else if (typeof data === "object" && data.content) {
          setRawContent(data.content);
        } else {
          setRawContent(JSON.stringify(data, null, 2));
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Container unreachable");
        setLoading(false);
      });
  }, [deploymentId]);

  if (loading) {
    return <div className="text-muted-foreground">Loading memory...</div>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">{error}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Memory will be available once the agent container is running.
        </p>
      </div>
    );
  }

  // Structured key/value display
  if (memory) {
    const filtered = memory.filter(
      (m) =>
        !search ||
        m.key.toLowerCase().includes(search.toLowerCase()) ||
        m.value.toLowerCase().includes(search.toLowerCase()),
    );

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">Memory</h2>
            <p className="text-sm text-muted-foreground">
              Read-only view of what your AI employee has learned.
            </p>
          </div>
          <Button variant="outline" size="sm">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>

        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search memory..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="space-y-3">
          {filtered.map((entry) => (
            <Card key={entry.key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono">
                  {entry.key}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                  {entry.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Raw markdown display
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Memory</h2>
          <p className="text-sm text-muted-foreground">
            Read-only view of what your AI employee has learned.
          </p>
        </div>
        <Button variant="outline" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Export
        </Button>
      </div>
      <Card>
        <CardContent className="p-6">
          <pre className="text-sm whitespace-pre-wrap font-mono text-muted-foreground">
            {rawContent}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
