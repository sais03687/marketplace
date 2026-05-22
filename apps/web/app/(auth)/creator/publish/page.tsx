"use client";

import { useState, useCallback, useEffect } from "react";
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
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import JSZip from "jszip";

interface ManifestData {
  name: string;
  slug: string;
  tagline: string;
  description: string;
  category: string;
  version: string;
  pricePerMonth: number;
  modelTier: string;
  runtime?: string;
  capabilities: Array<{ name: string; description: string }>;
}

interface ValidationResult {
  file: string;
  valid: boolean;
  message: string;
}

const REQUIRED_FILES = [
  "marketplace.json",
  "agent.py",
];

export default function PublishPage() {
  const [step, setStep] = useState(1);
  const [files, setFiles] = useState<File | null>(null);
  const [validations, setValidations] = useState<ValidationResult[]>([]);
  const [manifest, setManifest] = useState<ManifestData | null>(null);
  const [taglineOverride, setTaglineOverride] = useState("");
  const [descriptionOverride, setDescriptionOverride] = useState("");
  const [priceOverride, setPriceOverride] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [stripeOnboarded, setStripeOnboarded] = useState<boolean | null>(null);
  const [connectingStripe, setConnectingStripe] = useState(false);

  // Check Stripe Connect status when reaching step 3
  useEffect(() => {
    if (step === 3) {
      fetch("/api/creator/stripe/connect")
        .then((r) => r.json())
        .then((d) => setStripeOnboarded(d.stripeOnboarded ?? false))
        .catch(() => setStripeOnboarded(false));
    }
  }, [step]);

  const handleConnectStripe = async () => {
    setConnectingStripe(true);
    try {
      const res = await fetch("/api/creator/stripe/connect", { method: "POST" });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      // ignore
    }
    setConnectingStripe(false);
  };

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || !file.name.endsWith(".zip")) return;
      setFiles(file);
      await validateAndParsePackage(file);
    },
    [],
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFiles(file);
      await validateAndParsePackage(file);
    },
    [],
  );

  const validateAndParsePackage = async (file: File) => {
    const results: ValidationResult[] = [];
    setParseError(null);
    setManifest(null);

    if (file.size > 50 * 1024 * 1024) {
      results.push({
        file: file.name,
        valid: false,
        message: "Package exceeds 50MB limit",
      });
      setValidations(results);
      return;
    }

    results.push({
      file: file.name,
      valid: true,
      message: `${(file.size / 1024).toFixed(0)}KB zip file`,
    });

    try {
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);

      // Check required files
      for (const f of REQUIRED_FILES) {
        const exists = zip.file(f) !== null;
        results.push({
          file: f,
          valid: exists,
          message: exists ? "Found" : "Missing",
        });
      }

      // Parse manifest
      const manifestFile = zip.file("marketplace.json");
      if (manifestFile) {
        const text = await manifestFile.async("string");
        const parsed = JSON.parse(text) as ManifestData;
        setManifest(parsed);
        setTaglineOverride(parsed.tagline);
        setDescriptionOverride(parsed.description);
        setPriceOverride(String(parsed.pricePerMonth / 100));
      } else {
        setParseError("marketplace.json not found in package");
      }

      // Check optional files
      const hasQuestions = zip.file("onboarding/questions.json") !== null;
      const hasMemory = zip.file("onboarding/MEMORY_TEMPLATE.md") !== null;
      if (hasQuestions) {
        results.push({ file: "onboarding/questions.json", valid: true, message: "Found" });
      }
      if (hasMemory) {
        results.push({ file: "onboarding/MEMORY_TEMPLATE.md", valid: true, message: "Found" });
      }
    } catch {
      setParseError("Failed to read zip file");
    }

    setValidations(results);
  };

  const handleSubmit = async () => {
    if (!files) return;
    setSubmitting(true);

    const formData = new FormData();
    formData.append("package", files);
    if (taglineOverride) formData.append("tagline", taglineOverride);
    if (descriptionOverride) formData.append("description", descriptionOverride);
    if (priceOverride) formData.append("pricePerMonth", priceOverride);

    try {
      const res = await fetch("/api/packages/upload", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        setSubmitted(true);
      } else {
        const data = await res.json().catch(() => null);
        setParseError(data?.error || "Upload failed");
      }
    } catch {
      setParseError("Network error");
    }

    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Check className="h-12 w-12 text-emerald-500" />
        <h2 className="mt-4 text-xl font-semibold">Agent Live!</h2>
        <p className="mt-2 text-muted-foreground">
          Your agent is now listed on the marketplace and available for hire.
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
        {["Upload", "Review", "Submit"].map((label, i) => (
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

            {parseError && (
              <p className="text-sm text-red-500">{parseError}</p>
            )}

            <Button
              className="w-full"
              onClick={() => setStep(2)}
              disabled={!files || !manifest}
            >
              Continue
            </Button>
          </div>
        )}

        {step === 2 && manifest && (
          <div className="space-y-6">
            <Card>
              <CardContent className="p-5 space-y-3 text-sm">
                <h3 className="font-semibold">Parsed from marketplace.json</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">Name</span>
                  <span>{manifest.name}</span>
                  <span className="text-muted-foreground">Slug</span>
                  <span className="font-mono">{manifest.slug}</span>
                  <span className="text-muted-foreground">Version</span>
                  <span>{manifest.version}</span>
                  <span className="text-muted-foreground">Category</span>
                  <span>{manifest.category}</span>
                  <span className="text-muted-foreground">Model Tier</span>
                  <span>{manifest.modelTier}</span>
                  <span className="text-muted-foreground">Runtime</span>
                  <span>{manifest.runtime || "custom"}</span>
                  <span className="text-muted-foreground">Capabilities</span>
                  <span>{manifest.capabilities.length} defined</span>
                </div>
              </CardContent>
            </Card>

            <div>
              <label className="text-sm font-medium">
                Tagline <span className="text-muted-foreground">(override)</span>
              </label>
              <Input
                className="mt-1"
                value={taglineOverride}
                onChange={(e) => setTaglineOverride(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium">
                Description <span className="text-muted-foreground">(override)</span>
              </label>
              <Textarea
                className="mt-1"
                value={descriptionOverride}
                onChange={(e) => setDescriptionOverride(e.target.value)}
                rows={4}
              />
            </div>
            <div>
              <label className="text-sm font-medium">
                Price per month (USD) <span className="text-muted-foreground">(override)</span>
              </label>
              <Input
                className="mt-1"
                type="number"
                value={priceOverride}
                onChange={(e) => setPriceOverride(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                From manifest: ${manifest.pricePerMonth / 100}/mo
              </p>
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

        {step === 3 && manifest && (
          <div className="space-y-6">
            <Card>
              <CardContent className="p-5 space-y-3 text-sm">
                <h3 className="font-semibold">Review</h3>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Package</span>
                  <span>{files?.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Agent</span>
                  <span>{manifest.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Slug</span>
                  <span className="font-mono">{manifest.slug}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tagline</span>
                  <span className="text-right max-w-[60%] truncate">
                    {taglineOverride}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Runtime</span>
                  <span>Custom</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Price</span>
                  <span>${priceOverride}/mo</span>
                </div>
              </CardContent>
            </Card>

            {parseError && (
              <p className="text-sm text-red-500">{parseError}</p>
            )}

            {/* Stripe Connect gate */}
            {stripeOnboarded === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Checking payout account...
              </div>
            ) : !stripeOnboarded ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
                <div className="flex items-center gap-2 font-medium text-amber-800 mb-2">
                  <AlertCircle className="h-4 w-4" />
                  Payout account required
                </div>
                <p className="text-amber-700 mb-3">
                  Connect a Stripe account to receive earnings before your agent goes live.
                </p>
                <Button size="sm" onClick={handleConnectStripe} disabled={connectingStripe}>
                  {connectingStripe && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  <ExternalLink className="mr-2 h-3 w-3" />
                  Connect Stripe Account
                </Button>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                className="flex-1"
                onClick={handleSubmit}
                disabled={submitting || stripeOnboarded === false}
              >
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Publish Agent
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
