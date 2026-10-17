import { prisma } from "@/lib/db";
import { undeclaredGraphUse } from "@/lib/package-checks";
import { Prisma } from "@prisma/client";
import { isAdminUser, jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { claimUploadSlot } from "@/lib/upload-limit";
import { validateApiKey } from "@/lib/api-key-auth";
import { validateManifest, canonicalTier } from "@marketplace/agent-package-schema";
import { resolveModel } from "@/lib/model-resolver";
import { storeExtractedPackage } from "@/lib/package-storage";
import JSZip from "jszip";
import { nextVersionNumber, packageHash, supersedePending, unchangedSince } from "@/lib/agent-versions";
import { priceRejection } from "@/lib/agent-pricing";
import { getProvisioningQueue } from "@/lib/provisioning-queue";


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
  // Accept either Clerk session (browser) or API key (GitHub Actions / CLI)
  let userId: string;
  let creatorFromApiKey = null;

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer mkt_")) {
    creatorFromApiKey = await validateApiKey(authHeader);
    if (!creatorFromApiKey) return jsonError("Invalid API key", 401);
    userId = creatorFromApiKey.clerkUserId;
  } else {
    const authResult = await requireAuth();
    if ("error" in authResult) return authResult.error;
    userId = authResult.userId;
  }

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
  const runtime = ((manifest.runtime as string) || "custom").toUpperCase();

  if (runtime !== "CUSTOM") {
    return jsonError(
      "The OpenClaw runtime has been retired. Please use the custom runtime.",
      400,
    );
  }

  // 3b. For custom runtime: validate package contents
  if (runtime === "CUSTOM") {
    if (!zip.file("agent.py")) {
      return jsonError("Custom runtime packages must include agent.py", 400);
    }

    // Files that belong to the buyer, not to the package.
    //
    // MEMORY.md is everything the agent has learned about the company that
    // hired it; PRIVATE.md is their roster and internal details; memory/*.md is
    // the rest of the same. All three live beside agent.py in the running
    // agent, so a package carrying one would arrive on top of it.
    //
    // The runtime declines to write them, so nothing is lost either way — but a
    // file that is silently ignored is worse than one that is refused. The
    // creator ships it, vetting passes, and they are never told the thing they
    // wrote does nothing. Refused here, where there is somebody to tell and a
    // correct answer to point at.
    const BUYER_OWNED = ["MEMORY.md", "PRIVATE.md"];
    // At the package root, not by basename: the buyer's memory is MEMORY.md
    // beside agent.py, while a creator's own skills/MEMORY.md is a different
    // file and theirs to ship. Blocking that would be a false alarm.
    const buyerOwned = Object.keys(zip.files).find((path) => {
      if (zip.files[path].dir) return false;
      return BUYER_OWNED.includes(path) || /^memory\/[^/]+$/.test(path);
    });
    if (buyerOwned) {
      return jsonError(
        `Package must not contain "${buyerOwned}" — memory belongs to the buyer who ` +
          `hired the agent, and an update carrying one would arrive on top of what ` +
          `they have accumulated. To give a new hire something to start from, put it ` +
          `in onboarding/MEMORY_TEMPLATE.md instead: that seeds memory once, when the ` +
          `agent is first deployed, and is never written over it again.`,
        400,
      );
    }

    const RESERVED_FILES = [
      "adapter.py",
      "platform_llm.py",
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

    // The adapter does `from creator.agent import run_agent, resume_agent` at
    // module scope, so a package missing either one cannot start at all. Without
    // this check nothing says so: the manifest validates, the scan comes back
    // clean, the Docker image builds, and the only symptom is the vetting
    // sandbox reporting "Container did not become healthy within 60s" — which
    // names neither the file nor the symbol. Verified on 2026-08-04 by publishing
    // the same package twice, differing only in whether resume_agent existed:
    // without it, health check failed; with it, 5/5 passed.
    const agentSource = await zip.file("agent.py")!.async("string");
    const missingEntrypoints = ["run_agent", "resume_agent"].filter(
      (fn) => !new RegExp(`^\\s*(async\\s+)?def\\s+${fn}\\s*\\(`, "m").test(agentSource),
    );
    if (missingEntrypoints.length > 0) {
      return jsonError(
        `agent.py must define ${missingEntrypoints.join(" and ")} — the platform imports ` +
          `both when the container starts, and the agent cannot run without them`,
        400,
      );
    }

    const graphProblem = await undeclaredGraphUse(zip, manifest);
    if (graphProblem) return jsonError(graphProblem, 400);

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

  // 3c. Enforce minimum pricing per model tier.
  //
  // The tier is derived from the model pick when there is one. It used to be
  // declared independently, which meant a creator could name the haiku tier,
  // pay the $29 floor, and run whatever model their code constructed — the tier
  // chose nothing but the price. Deriving it makes the floor follow the model.
  //
  // The model is resolved against the provider rather than a hand-kept list, so
  // any of the four hundred it serves can be published and the tier still comes
  // from what that model costs. A typo is caught here, at publish time, instead
  // of at hire time in front of a buyer.
  const declaredModel =
    typeof manifest.model === "string" ? manifest.model.trim() : null;

  let derivedTier: string | null = null;
  if (declaredModel) {
    const resolved = await resolveModel(declaredModel);
    if ("error" in resolved) return jsonError(resolved.error, 400);
    derivedTier = resolved.model.tier;
  }

  // Falls back to the declared tier only when no model was named. `canonicalTier`
  // maps the retired haiku/sonnet/opus spellings onto the current ones.
  const modelTierRaw = (
    derivedTier ?? canonicalTier(manifest.modelTier) ?? "standard"
  ).toUpperCase();
  // Both doors now speak dollars. The form always did — it parsed a dollar
  // figure and multiplied — while the manifest was read as cents, so the same
  // route accepted 29 from one and 2900 from the other for the same price.
  // Cents survive only past this line, because Stripe charges in them.
  const pricePerMonthRaw = formData.get("pricePerMonth") as string | null;
  const priceCheck = pricePerMonthRaw
    ? parseInt(pricePerMonthRaw, 10) * 100
    : (manifest.pricePerMonth as number) * 100;

  const uploadPriceError = priceRejection(priceCheck, modelTierRaw, manifest.resources as string | undefined);
  if (uploadPriceError) {
    return jsonError(
      uploadPriceError,
      400,
    );
  }

  // 4. Check slug uniqueness (only for new agents)
  const existingAgent = await prisma.agent.findUnique({
    where: { slug },
  });

  // Creator access is gated during the beta: a person requests access and an
  // admin approves it. Uploading no longer silently creates a creator — an
  // un-approved account cannot put code on the platform, which is what keeps the
  // sandbox (and eventually production) from running a stranger's code.
  const creator = creatorFromApiKey ?? await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) {
    return jsonError(
      "Creator access is invite-only during the beta. Request access from the Creator page and an admin will review it.",
      403,
    );
  }
  if (creator.status !== "APPROVED") {
    return jsonError(
      creator.status === "PENDING"
        ? "Your creator access request is still under review. You'll be able to publish once it's approved."
        : "Your creator access request was not approved. Contact the team if you think this is a mistake.",
      403,
    );
  }

  if (existingAgent && existingAgent.creatorId !== creator.id) {
    return jsonError(`Slug "${slug}" is already taken by another creator`, 409);
  }

  // A dry run answers "would this upload be accepted?" with every check above,
  // and stops before anything is stored or queued for vetting. The GitHub
  // workflow calls it before the real upload, so a package that would be
  // refused costs the creator seconds rather than a slot in the vetting queue.
  if (new URL(request.url).searchParams.get("dryRun") === "1") {
    let version = "1";
    if (existingAgent) {
      // Same refusal as the real upload, so the GitHub workflow can skip a push
      // that did not change the agent instead of failing on it.
      const same = await unchangedSince(prisma, existingAgent.id, packageHash(await zipFiles(zip)));
      if (same) {
        return jsonError(`Nothing has changed since version ${same}, so there is nothing new to publish.`, 409);
      }
      version = await nextVersionNumber(prisma, existingAgent.id);
    }
    return jsonSuccess({
      dryRun: true,
      slug,
      version,
      modelTier: modelTierRaw,
      pricePerMonth: priceCheck / 100,
    });
  }

  // Only real uploads count, and only once every check above has passed, so a
  // package refused for a typo never uses up one of the day's slots. Reviewers
  // are exempt: they republish first-party agents and re-run vetting by hand.
  if (!isAdminUser(userId)) {
    const slot = await claimUploadSlot(creator.id);
    if (!slot.allowed) {
      return jsonError(
        `You have reached today's limit of ${slot.limit} uploads. Each upload is built and ` +
          `vetted, so the limit resets at midnight UTC. Meanwhile, \`agentstore test\` runs ` +
          `your agent on your own machine as the platform would — see the creator docs.`,
        429,
      );
    }
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

  // 6. Store all extracted files, under the number the platform assigns
  // (lib/agent-versions.ts). An upload identical to the latest is refused.
  const files = await zipFiles(zip);
  const hash = packageHash(files);
  if (existingAgent) {
    const same = await unchangedSince(prisma, existingAgent.id, hash);
    if (same) {
      return jsonError(`Nothing has changed since version ${same}, so there is nothing new to publish.`, 409);
    }
  }
  const version = existingAgent ? await nextVersionNumber(prisma, existingAgent.id) : "1";

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
  const agentModel = declaredModel;
  const pricePerMonth = priceCheck;
  const capabilities = manifest.capabilities as Array<{
    name: string;
    description: string;
  }>;

  // 8. Create everything in a transaction
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // New agents start as PENDING until an admin approves them.
      // Existing agents keep their current status — the new version goes to PENDING
      // and won't be used for provisioning until approved.
      // A new version of an existing agent changes nothing a buyer sees until it
      // is approved: the listing text, capabilities, model and declared access
      // are applied by the approval (packages/[id]/vet-decision), from the
      // manifest stored on the version. Applying them here put unreviewed claims
      // on a live listing, and a model change reached running hires early.
      const agent = existingAgent
        ? existingAgent.status === "SUSPENDED"
          ? await tx.agent.update({ where: { id: existingAgent.id }, data: { status: "IN_REVIEW" } })
          : existingAgent
        : await tx.agent.create({
            data: {
              slug,
              name: agentName,
              tagline,
              description,
              category: category as any,
              pricePerMonth,
              model: agentModel,
              modelTier: modelTier as any,
              creatorId: creator.id,
              status: "IN_REVIEW",
              runtime,
              currentVersion: version,
              onboardingQuestions: onboardingQuestions ?? undefined,
              memoryTemplate: memoryTemplate ?? undefined,
              graphScopes: manifest.graphScopes ?? Prisma.DbNull,
            },
          });

      const agentVersion = await tx.agentVersion.create({
        data: {
          agentId: agent.id,
          version,
          packageUrl: `storage://${slug}/${version}`,
          manifestData: {
            ...manifest,
            version,
            // The wizard's own wording wins over the manifest's, as it does for a
            // new agent, and reaches the listing when this version is approved.
            tagline,
            description,
            _packageHash: hash,
            // What the upload resolved, so approval applies the same model and
            // tier without asking the provider again.
            _resolvedModel: agentModel,
            _modelTier: modelTier,
          } as any,
          storagePath,
          vetStatus: "PENDING",
          publishedAt: null,
        },
      });
      await supersedePending(tx, agent.id, agentVersion.id, version);

      // A new agent's capabilities; an existing agent's change on approval.
      if (!existingAgent && capabilities.length > 0) {
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
  } catch (e) {
    throw e;
  }

  console.log("[upload] agent:", result.agent.slug, "status:", result.agent.status);

  // Start the review the creator was just told about.
  //
  // Publishing set vetStatus to PENDING and stopped. `enqueueVetPackage` existed
  // in the provisioning service and nothing called it, so the only way to vet a
  // package was for someone to POST /api/packages/:id/vet-sandbox by hand — and
  // the wizard meanwhile said "Your agent is under review", which was not true
  // of anything. On 2026-08-17 the record showed no package had ever been
  // vetted; the first one put through the pipeline by hand passed.
  //
  // Failure here is logged and swallowed on purpose. The package is uploaded and
  // the version row is written by this point; losing the queue should leave a
  // package awaiting vetting, not lose the upload the creator just made. The
  // manual route still works as the retry.
  if (result.version.storagePath && result.agent.runtime === "CUSTOM") {
    try {
      const job = await getProvisioningQueue().add("vet_package", {
        type: "vet_package",
        versionId: result.version.id,
      } as any);
      await prisma.agentVersion.update({
        where: { id: result.version.id },
        data: {
          vetNotes: "Queued for vetting sandbox...",
          testResults: { status: "queued", queuedAt: new Date().toISOString() } as any,
        },
      });
      console.log("[upload] vetting queued:", job.id, "for version", result.version.id);
    } catch (e) {
      console.error("[upload] could not queue vetting:", e);
    }
  }

  return jsonSuccess(result, 201);
}


async function zipFiles(zip: JSZip): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (!zipEntry.dir) files.set(relativePath, await zipEntry.async("nodebuffer"));
  }
  return files;
}
