import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { generateApiKey } from "@/lib/api-key-auth";

// GET /api/creator/api-keys — list keys (prefix + metadata only, never the real key)
export async function GET() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({ where: { clerkUserId: userId } });
  if (!creator) return jsonError("Creator not found", 404);

  const keys = await prisma.creatorApiKey.findMany({
    where: { creatorId: creator.id },
    select: { id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess(keys);
}

// POST /api/creator/api-keys — generate a new key
export async function POST(request: Request) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({ where: { clerkUserId: userId } });
  if (!creator) return jsonError("Creator not found", 404);

  const existing = await prisma.creatorApiKey.count({ where: { creatorId: creator.id } });
  if (existing >= 10) return jsonError("Maximum of 10 API keys per creator", 400);

  let name = "Default";
  try {
    const body = await request.json();
    if (body.name && typeof body.name === "string") name = body.name.slice(0, 64);
  } catch {}

  const { key, prefix, hash } = generateApiKey();

  await prisma.creatorApiKey.create({
    data: { creatorId: creator.id, name, keyHash: hash, keyPrefix: prefix },
  });

  // Return the plaintext key ONCE — never stored, never retrievable again
  return jsonSuccess({ key, prefix, name }, 201);
}
