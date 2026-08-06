import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { validateManifest } from "@marketplace/agent-package-schema";
import { storeExtractedPackage } from "@/lib/package-storage";
import JSZip from "jszip";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });
  if (!creator) return jsonError("Creator not found", 404);

  const agent = await prisma.agent.findUnique({
    where: { slug },
    include: {
      versions: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!agent) return jsonError("Agent not found", 404);
  if (agent.creatorId !== creator.id)
    return jsonError("Not authorized", 403);

  return jsonSuccess(agent.versions);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });
  if (!creator) return jsonError("Creator not found", 404);

  const agent = await prisma.agent.findUnique({
    where: { slug },
  });
  if (!agent) return jsonError("Agent not found", 404);
  if (agent.creatorId !== creator.id)
    return jsonError("Not authorized", 403);

  const formData = await request.formData();
  const packageFile = formData.get("package") as File | null;
  const changelog = formData.get("changelog") as string | null;

  if (!packageFile) return jsonError("Package file required", 400);

  // Extract zip
  let zip: JSZip;
  try {
    const buffer = await packageFile.arrayBuffer();
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return jsonError("Invalid zip file", 400);
  }

  // Parse manifest
  const manifestFile = zip.file("marketplace.json");
  if (!manifestFile)
    return jsonError("marketplace.json not found in package", 400);

  let manifest: Record<string, unknown>;
  try {
    const text = await manifestFile.async("string");
    manifest = JSON.parse(text);
  } catch {
    return jsonError("Invalid marketplace.json", 400);
  }

  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    return jsonError(
      `Manifest validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
      400,
    );
  }

  const version = manifest.version as string;
  const versionRuntime = ((manifest.runtime as string) || "custom").toUpperCase();

  if (versionRuntime === "OPENCLAW") {
    return jsonError(
      "The OpenClaw runtime has been retired. Please use the custom runtime.",
      400,
    );
  }

  // Validate custom runtime package contents
  if (versionRuntime === "CUSTOM") {
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

  // Enforce minimum pricing per model tier
  const versionModelTier = (manifest.modelTier as string || "").toUpperCase();
  const MIN_PRICE_CENTS: Record<string, number> = {
    HAIKU: 2900,
    SONNET: 5900,
    OPUS: 14900,
  };
  const versionPrice = manifest.pricePerMonth as number | undefined;
  // Zero is not a cheap price, it is a free agent, and the platform supports
  // those deliberately — the hire flow guards on `pricePerMonth > 0` and
  // provisions without payment when it is zero. Applying a tier floor to it
  // meant a free agent could never publish a version at all: 0 is below every
  // minimum, so the upload was rejected for being too cheap to exist.
  if (versionPrice !== undefined && versionPrice > 0 && versionModelTier) {
    const minPrice = MIN_PRICE_CENTS[versionModelTier] || 2900;
    if (versionPrice < minPrice) {
      return jsonError(
        `Minimum price for ${versionModelTier.toLowerCase()} tier is $${(minPrice / 100).toFixed(0)}/month`,
        400,
      );
    }
  }

  // Publishing a version does not change what the agent costs.
  //
  // This route validates the manifest price above and then never writes it —
  // it only stores manifestData on the version, and approval reads that solely
  // for capabilities. So a creator could change the price in their manifest,
  // watch it pass validation, watch the version get approved, and find the
  // agent still charging the old amount, with nothing anywhere saying why.
  //
  // Refusing is the right half to keep. An agent's price is what its buyers are
  // already paying, and a version bump is the wrong moment to move it silently.
  // PATCH /api/agents/[slug] is the deliberate path, so point at it rather than
  // accepting a number that will be discarded.
  if (versionPrice !== undefined && versionPrice !== agent.pricePerMonth) {
    return jsonError(
      `This version's manifest sets pricePerMonth to ${versionPrice} but ${slug} ` +
        `currently costs ${agent.pricePerMonth}. Publishing a version does not change ` +
        `the price, because buyers are already paying the current one. Either match ` +
        `the manifest to the current price, or change the price deliberately first.`,
      409,
    );
  }

  // Check version doesn't already exist as an approved/live version
  const existingVersion = await prisma.agentVersion.findFirst({
    where: { agentId: agent.id, version },
  });
  if (existingVersion && existingVersion.vetStatus !== "PENDING") {
    return jsonError(`Version ${version} already exists and has been approved. Bump the version number.`, 409);
  }
  if (!existingVersion && version === agent.currentVersion) {
    return jsonError(
      `Version ${version} is the same as current version. Bump the version number.`,
      409,
    );
  }

  // Store files
  const files = new Map<string, Buffer>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      files.set(path, await entry.async("nodebuffer"));
    }
  }
  const storagePath = await storeExtractedPackage(slug, version, files);

  // If a pending version already exists for this number, replace it
  let agentVersion;
  if (existingVersion) {
    agentVersion = await prisma.agentVersion.update({
      where: { id: existingVersion.id },
      data: {
        packageUrl: `storage://${slug}/${version}`,
        manifestData: manifest as any,
        storagePath,
        changelog: changelog ?? null,
        vetStatus: "PENDING",
      },
    });
  } else {
    agentVersion = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        version,
        packageUrl: `storage://${slug}/${version}`,
        manifestData: manifest as any,
        storagePath,
        changelog: changelog ?? null,
        vetStatus: "PENDING",
      },
    });
  }

  return jsonSuccess(agentVersion, 201);
}
