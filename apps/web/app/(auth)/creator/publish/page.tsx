"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Upload,
  Check,
  X,
  FileText,
  Loader2,
} from "lucide-react";

interface ValidationResult {
  file: string;
  valid: boolean;
  message: string;
}

const REQUIRED_FILES = [
  "marketplace.json",
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
];

export default function PublishPage() {
  const [step, setStep] = useState(1);
  const [files, setFiles] = useState<File | null>(null);
  const [validations, setValidations] = useState<ValidationResult[]>([]);
  const [runtime, setRuntime] = useState<"OPENCLAW" | "CUSTOM">("OPENCLAW");
  const [manifest, setManifest] = useState<Record<string, string>>({
    tagline: "",
    description: "",
  });
  const [price, setPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || !file.name.endsWith(".zip")) return;
      setFiles(file);
      validatePackage(file);
    },
    [],
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFiles(file);
      validatePackage(file);
    },
    [],
  );

  const validatePackage = async (file: File) => {
    // Client-side validation: check zip contents
    const results: ValidationResult[] = [];

    // For now, do basic checks
    if (file.size > 50 * 1024 * 1024) {
      results.push({
        file: file.name,
        valid: false,
        message: "Package exceeds 50MB limit",
      });
    } else {
      results.push({
        file: file.name,
        valid: true,
        message: `${(file.size / 1024).toFixed(0)}KB zip file`,
      });
    }

    for (const f of REQUIRED_FILES) {
      results.push({
        file: f,
        valid: true, // Would need JSZip for actual check
        message: "Will be verified on upload",
      });
    }

    setValidations(results);
  };

  const handleSubmit = async () => {
    if (!files) return;
    setSubmitting(true);

    const formData = new FormData();
    formData.append("package", files);
    formData.append("tagline", manifest.tagline);
    formData.append("description", manifest.description);
    formData.append("pricePerMonth", price);
    formData.append("runtime", runtime);

    try {
      const res = await fetch("/api/packages/upload", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        setSubmitted(true);
      }
    } catch {
      // Handle error
    }

    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Check className="h-12 w-12 text-emerald-500" />
        <h2 className="mt-4 text-xl font-semibold">Package Submitted</h2>
        <p className="mt-2 text-muted-foreground">
          Your agent package is being vetted. You&apos;ll be notified when it&apos;s
          approved.
        </p>
        <Button className="mt-6" onClick={() => window.location.href = "/creator"}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold">Publish Agent</h1>
      <p className="text-muted-foreground">
        Upload your agent package for review and listing.
      </p>

      {/* Progress */}
      <div className="mt-6 flex items-center gap-1">
        {["Upload", "Details", "Pricing", "Submit"].map((label, i) => (
          <div key={label} className="flex-1">
            <div
              className={cn(
                "h-1 rounded-full",
                i < step ? "bg-primary" : "bg-muted",
              )}
            />
            <p
              className={cn(
                "mt-1 text-center text-[10px]",
                i + 1 === step ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              {label}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-8">
        {step === 1 && (
          <div className="space-y-6">
            <div
              className="relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-12 transition-colors hover:border-primary/50"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">Drop your agent package here</p>
              <p className="text-sm text-muted-foreground">or click to browse</p>
              <input
                type="file"
                accept=".zip"
                className="absolute inset-0 cursor-pointer opacity-0"
                onChange={handleFileSelect}
              />
            </div>

            {validations.length > 0 && (
              <div className="space-y-2">
                {validations.map((v) => (
                  <div key={v.file} className="flex items-center gap-2 text-sm">
                    {v.valid ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <X className="h-4 w-4 text-red-500" />
                    )}
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="font-mono text-xs">{v.file}</span>
                    <span className="text-muted-foreground">{v.message}</span>
                  </div>
                ))}
              </div>
            )}

            <Button
              className="w-full"
              onClick={() => setStep(2)}
              disabled={!files}
            >
              Continue
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <div>
              <label className="text-sm font-medium">Tagline</label>
              <Input
                className="mt-1"
                value={manifest.tagline}
                onChange={(e) =>
                  setManifest({ ...manifest, tagline: e.target.value })
                }
                placeholder="One-line description of your agent"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                className="mt-1"
                value={manifest.description}
                onChange={(e) =>
                  setManifest({ ...manifest, description: e.target.value })
                }
                placeholder="Detailed description of what your agent does..."
                rows={6}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Runtime</label>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setRuntime("OPENCLAW")}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    runtime === "OPENCLAW"
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "hover:border-muted-foreground/30",
                  )}
                >
                  <p className="text-sm font-medium">OpenClaw</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Managed runtime. No Docker needed.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setRuntime("CUSTOM")}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    runtime === "CUSTOM"
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "hover:border-muted-foreground/30",
                  )}
                >
                  <p className="text-sm font-medium">Custom</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Your own Docker container with adapter.
                  </p>
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button className="flex-1" onClick={() => setStep(3)}>
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6">
            <div>
              <label className="text-sm font-medium">
                Price per month (USD)
              </label>
              <Input
                className="mt-1"
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="499"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Enter price in dollars. Customers will be charged monthly.
              </p>
            </div>

            {price && (
              <Card>
                <CardContent className="p-4 text-sm">
                  <div className="flex justify-between">
                    <span>Customer pays</span>
                    <span className="font-medium">
                      ${parseInt(price || "0")}/mo
                    </span>
                  </div>
                  <div className="flex justify-between mt-1">
                    <span>Platform fee (30%)</span>
                    <span className="text-muted-foreground">
                      -${Math.round(parseInt(price || "0") * 0.3)}/mo
                    </span>
                  </div>
                  <div className="flex justify-between mt-1 pt-1 border-t font-medium">
                    <span>You earn</span>
                    <span className="text-emerald-600">
                      ${Math.round(parseInt(price || "0") * 0.7)}/mo
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button className="flex-1" onClick={() => setStep(4)}>
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-6">
            <Card>
              <CardContent className="p-5 space-y-3 text-sm">
                <h3 className="font-semibold">Review</h3>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Package</span>
                  <span>{files?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tagline</span>
                  <span className="text-right max-w-[60%] truncate">
                    {manifest.tagline}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Runtime</span>
                  <span>{runtime === "CUSTOM" ? "Custom (Docker)" : "OpenClaw (Managed)"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Price</span>
                  <span>${price}/mo</span>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(3)}>
                Back
              </Button>
              <Button
                className="flex-1"
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit for Review
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
