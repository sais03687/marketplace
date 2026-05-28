import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { validateManifest } from "@marketplace/agent-package-schema";
import { storeExtractedPackage } from "@/lib/package-storage";
import JSZip from "jszip";

// ── Code scanning ─────────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bimport\s+subprocess\b/, label: "import subprocess" },
  { pattern: /\bfrom\s+subprocess\b/, label: "from subprocess" },
  { pattern: /\bos\.system\s*\(/, label: "os.system()" },
  { pattern: /\bos\.popen\s*\(/, label: "os.popen()" },
  { pattern: /\bos\.exec[vple]+\s*\(/, label: "os.exec*()" },
  { pattern: /\bos\.spawn[vple]*\s*\(/, label: "os.spawn*()" },
  { pattern: /(?<!\.)\beval\s*\(/, label: "eval()" },
  { pattern: /\b__import__\s*\(/, label: "dynamic __import__()" },
  { pattern: /\bimport\s+ctypes\b/, label: "import ctypes" },
  { pattern: /\bfrom\s+ctypes\b/, label: "from ctypes" },
  { pattern: /\bimport\s+pty\b/, label: "import pty" },
  { pattern: /\bimport\s+pickle\b/, label: "import pickle (unsafe deserialization)" },
  { pattern: /\bimport\s+marshal\b/, label: "import marshal" },
  // Additional patterns not in earlier version — added to match validator
  { pattern: /(?<!\.)\bexec\s*\(/, label: "exec() — same power as eval()" },
  { pattern: /(?<!\.)\bcompile\s*\(/, label: "compile() — creates code objects from strings" },
  { pattern: /\bimport\s+multiprocessing\b/, label: "import multiprocessing (subprocess-equivalent)" },
  { pattern: /\bfrom\s+multiprocessing\b/, label: "from multiprocessing" },
  { pattern: /\bimport\s+socket\b|\bfrom\s+socket\b/, label: "import socket (raw socket access)" },
];

async function scanPythonFiles(
  zip: JSZip,
): Promise<{ file: string; finding: string }[]> {
  const findings: { file: string; finding: string }[] = [];

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.endsWith(".py")) continue;
    const source = await entry.async("string");
    const lines = source.split("\n");

    for (const { pattern, label } of DANGEROUS_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip commented-out lines
        if (line.trimStart().startsWith("#")) continue;
        if (pattern.test(line)) {
          findings.push({ file: path, finding: `${label} on line ${i + 1}` });
          break; // one finding per pattern per file is enough
        }
      }
    }
  }

  return findings;
}

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const formData = await request.formData();
  const packageFile = formData.get("package") as File | null;

  // Optional overrides from form
  const taglineOverride = formData.get("tagline") as string | null;
  const descriptionOverride = formData.get("description") as string | null;
  const priceOverride = formData.get("pricePerMonth") as string | null;

  if (!packageFile) {
    return jsonError("Package file required", 400);
  }

  if (packageFile.size > 50 * 1024 * 1024) {
    return jsonError("Package exceeds 50MB limit", 400);
  }

  // 1. Extract zip
  let zip: JSZip;
  try {
    const buffer = await packageFile.arrayBuffer();
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return jsonError("Invalid zip file", 400);
  }

  // 2. Find and parse marketplace.json
  const manifestFile = zip.file("marketplace.json");
  if (!manifestFile) {
    return jsonError("marketplace.json not found in package", 400);
  }

  let manifest: Record<string, unknown>;
  try {
    const manifestText = await manifestFile.async("string");
    manifest = JSON.parse(manifestText);
  } catch {
    return jsonError("Invalid marketplace.json (not valid JSON)", 400);
  }

  // 3. Validate manifest
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    return jsonError(
      `Manifest validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      400,
    );
  }

  const slug = manifest.slug as string;
  const version = manifest.version as string;
  const runtime = ((manifest.runtime as string) || "custom").toUpperCase() as
    | "OPENCLAW"
    | "CUSTOM";

  if (runtime === "OPENCLAW") {
    return jsonError(
      "The OpenClaw runtime is not currently available. Please use the custom runtime.",
      400,
    );
  }

  // 3b. For custom runtime: validate package contents
  if (runtime === "CUSTOM") {
    if (!zip.file("agent.py")) {
      return jsonError("Custom runtime packages must include agent.py", 400);
    }

    const RESERVED_FILES = [
      "adapter.py",
      "Dockerfile",
      "platform-requirements.txt",
    ];
    for (const reserved of RESERVED_FILES) {
      if (zip.file(reserved)) {
        return jsonError(
          `Package must not contain "${reserved}" — this is a platform-managed file`,
          400,
        );
      }
    }

    const SHADOWED_MODULES = [
      "fastapi.py", "uvicorn.py", "httpx.py", "pydantic.py",
      "json.py", "os.py", "sys.py", "subprocess.py", "socket.py",
      "asyncio.py", "pathlib.py", "importlib.py",
    ];
    for (const mod of SHADOWED_MODULES) {
      if (zip.file(mod)) {
        return jsonError(
          `Package must not contain "${mod}" — this shadows a system module`,
          400,
        );
      }
    }
  }

  // 3b-1b. Scan all .py files for dangerous patterns
  if (runtime === "CUSTOM") {
    const findings = await scanPythonFiles(zip);
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}: ${f.finding}`).join("; ");
      return jsonError(`Package contains disallowed code patterns — ${detail}`, 400);
    }
  }

  // 3b-2. For OpenClaw runtime: validate workspace contents
  if (runtime === "OPENCLAW") {
    if (!zip.file("AGENTS.md")) {
      return jsonError("OpenClaw packages must include AGENTS.md", 400);
    }
    if (!zip.file("SOUL.md")) {
      return jsonError("OpenClaw packages must include SOUL.md", 400);
    }
    const RESERVED_OPENCLAW = ["openclaw.json", ".env"];
    for (const reserved of RESERVED_OPENCLAW) {
      if (zip.file(reserved)) {
        return jsonError(
          `Package must not contain "${reserved}" — this is generated by the platform`,
          400,
        );
      }
    }
  }

  // 3c. Enforce minimum pricing per model tier
  const modelTierRaw = (manifest.modelTier as string).toUpperCase();
  const pricePerMonthRaw = formData.get("pricePerMonth") as string | null;
  const priceCheck = pricePerMonthRaw
    ? parseInt(pricePerMonthRaw, 10) * 100
    : (manifest.pricePerMonth as number);

  const MIN_PRICE_CENTS: Record<string, number> = {
    HAIKU: 2900,   // $29/mo — growth-phase minimum, revisit after product-market fit
    SONNET: 5900,  // $59/mo
    OPUS: 14900,   // $149/mo
  };
  const minPrice = MIN_PRICE_CENTS[modelTierRaw] || 2900;
  if (priceCheck < minPrice) {
    return jsonError(
      `Minimum price for ${modelTierRaw.toLowerCase()} tier is $${(minPrice / 100).toFixed(0)}/month`,
      400,
    );
  }

  // 4. Check slug uniqueness (only for new agents)
  const existingAgent = await prisma.agent.findUnique({
    where: { slug },
  });

  // Ensure creator exists
  let creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) {
    creator = await prisma.creator.create({
      data: {
        clerkUserId: userId,
        displayName: "Creator",
        email: `${userId}@marketplace.dev`,
      },
    });
  }

  if (existingAgent && existingAgent.creatorId !== creator.id) {
    return jsonError(`Slug "${slug}" is already taken by another creator`, 409);
  }

  // 5. Extract onboarding files
  let onboardingQuestions: any | null = null;
  let memoryTemplate: string | null = null;

  const questionsFile = zip.file("onboarding/questions.json");
  if (questionsFile) {
    try {
      const questionsText = await questionsFile.async("string");
      onboardingQuestions = JSON.parse(questionsText);
    } catch {
      // Non-fatal: questions.json is optional or may be malformed
    }
  }

  const memoryFile = zip.file("onboarding/MEMORY_TEMPLATE.md");
  if (memoryFile) {
    try {
      memoryTemplate = await memoryFile.async("string");
    } catch {
      // Non-fatal
    }
  }

  // 6. Store all extracted files
  const files = new Map<string, Buffer>();
  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (!zipEntry.dir) {
      const content = await zipEntry.async("nodebuffer");
      files.set(relativePath, content);
    }
  }

  let storagePath: string;
  try {
    storagePath = await storeExtractedPackage(slug, version, files);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[upload] Blob storage failed:", msg);
    return jsonError(`Failed to store package files: ${msg}`, 500);
  }

  // 7. Apply overrides
  const agentName = manifest.name as string;
  const tagline = taglineOverride || (manifest.tagline as string);
  const description = descriptionOverride || (manifest.description as string);
  const category = manifest.category as string;
  const modelTier = modelTierRaw;
  const pricePerMonth = priceCheck;
  const capabilities = manifest.capabilities as Array<{
    name: string;
    description: string;
  }>;

  // 8. Create everything in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // New agents start as PENDING until an admin approves them.
    // Existing agents keep their current status — the new version goes to PENDING
    // and won't be used for provisioning until approved.
    const agent = existingAgent
      ? await tx.agent.update({
          where: { id: existingAgent.id },
          data: {
            name: agentName,
            tagline,
            description,
            category: category as any,
            pricePerMonth,
            modelTier: modelTier as any,
            runtime,
            onboardingQuestions: onboardingQuestions ?? undefined,
            memoryTemplate: memoryTemplate ?? undefined,
            // Do NOT update currentVersion or status — the new version must be
            // approved before it becomes the active version.
          },
        })
      : await tx.agent.create({
          data: {
            slug,
            name: agentName,
            tagline,
            description,
            category: category as any,
            pricePerMonth,
            modelTier: modelTier as any,
            creatorId: creator.id,
            status: "IN_REVIEW",
            runtime,
            currentVersion: version,
            onboardingQuestions: onboardingQuestions ?? undefined,
            memoryTemplate: memoryTemplate ?? undefined,
          },
        });

    const agentVersion = await tx.agentVersion.create({
      data: {
        agentId: agent.id,
        version,
        packageUrl: `storage://${slug}/${version}`,
        manifestData: manifest as any,
        storagePath,
        vetStatus: "PENDING",
        publishedAt: null,
      },
    });

    // Replace capabilities atomically
    await tx.capability.deleteMany({ where: { agentId: agent.id } });
    if (capabilities.length > 0) {
      await tx.capability.createMany({
        data: capabilities.map((cap) => ({
          agentId: agent.id,
          name: cap.name,
          description: cap.description,
        })),
      });
    }

    return { agent, version: agentVersion };
  });

  console.log("[upload] created agent:", result.agent.slug, "status:", result.agent.status, "creatorId:", result.agent.creatorId);
  return jsonSuccess(result, 201);
}
