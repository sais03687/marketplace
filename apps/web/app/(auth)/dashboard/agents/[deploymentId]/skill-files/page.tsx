"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, FileCode, MessageSquare } from "lucide-react";

interface SkillFile {
  name: string;
  path: string;
  content: string;
}

export default function SkillFilesPage() {
  const params = useParams();
  const deploymentId = params.deploymentId as string;
  const [skills, setSkills] = useState<SkillFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/deployments/${deploymentId}/skills`)
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json();
          setError(data.error || "Failed to load skills");
          setLoading(false);
          return;
        }
        const data = await r.json();
        setSkills(data.skills || data || []);
        setLoading(false);
      })
      .catch(() => {
        setError("Container unreachable");
        setLoading(false);
      });
  }, [deploymentId]);

  if (loading) {
    return <div className="text-muted-foreground">Loading skill files...</div>;
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 font-medium">{error}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Skill files will be available once the agent container is running.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Skill Files</h2>
        <p className="text-sm text-muted-foreground">
          Read-only view of the skills that power your AI employee.
        </p>
      </div>

      <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
        Skill files belong to the creator. Your memory and preferences belong
        to you.
      </div>

      {skills.length === 0 ? (
        <p className="text-muted-foreground">No skill files available.</p>
      ) : (
        <div className="space-y-3">
          {skills.map((skill) => (
            <Card key={skill.name}>
              <CardHeader
                className="cursor-pointer pb-2"
                onClick={() =>
                  setExpanded(expanded === skill.name ? null : skill.name)
                }
              >
                <CardTitle className="flex items-center gap-2 text-sm">
                  <FileCode className="h-4 w-4 text-primary" />
                  {skill.name}
                </CardTitle>
              </CardHeader>
              {expanded === skill.name && (
                <CardContent>
                  <pre className="rounded-lg bg-muted p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                    {skill.content}
                  </pre>
                  <div className="mt-3">
                    <Button variant="outline" size="sm">
                      <MessageSquare className="mr-2 h-3 w-3" />
                      Request Customization
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
