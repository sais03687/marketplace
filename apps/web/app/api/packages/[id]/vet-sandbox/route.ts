import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { Queue } from "bullmq";

let vetQueue: Queue | null = null;
function getVetQueue() {
  if (!vetQueue) {
    vetQueue = new Queue("provisioning", {
      connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
    });
  }
  return vetQueue;
}

// POST /api/packages/[id]/vet-sandbox — enqueue a vetting job
// Body (all optional):
//   customTests: Array<{ name: string; endpoint: string; method?: string; body?: unknown; expectStatus?: number }>
//   skipDefaultTests?: boolean  — omit the 5 built-in platform tests
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;

  const { id: versionId } = await params;

  const version = await prisma.agentVersion.findUnique({
    where: { id: versionId },
    select: { id: true, vetStatus: true, storagePath: true, agent: { select: { runtime: true } } },
  });

  if (!version) return jsonError("Version not found", 404);
  if (!version.storagePath) return jsonError("No package file associated with this version — cannot vet", 400);

  if (version.agent.runtime !== "CUSTOM") {
    return jsonError("Sandbox vetting is only available for custom runtime packages", 400);
  }

  // Parse optional custom test config from body
  let customTests: unknown[] | undefined;
  let skipDefaultTests = false;
  try {
    const body = await req.json().catch(() => ({}));
    customTests = Array.isArray(body?.customTests) ? body.customTests : undefined;
    skipDefaultTests = body?.skipDefaultTests === true;
  } catch { /* no body — fine */ }

  const queue = getVetQueue();
  const job = await queue.add("vet_package", {
    type: "vet_package",
    versionId,
    customTests,
    skipDefaultTests,
  } as any);

  await prisma.agentVersion.update({
    where: { id: versionId },
    data: {
      vetNotes: "Queued for vetting sandbox...",
      testResults: { status: "queued", queuedAt: new Date().toISOString() } as any,
    },
  });

  return jsonSuccess({ jobId: job.id, message: "Vetting job queued" }, 202);
}

// GET /api/packages/[id]/vet-sandbox — poll for results
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;

  const { id: versionId } = await params;

  const version = await prisma.agentVersion.findUnique({
    where: { id: versionId },
    select: { vetNotes: true, testResults: true, vetStatus: true },
  });

  if (!version) return jsonError("Version not found", 404);

  return jsonSuccess({
    vetNotes: version.vetNotes,
    testResults: version.testResults,
    vetStatus: version.vetStatus,
  });
}
