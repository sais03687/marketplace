import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

// DELETE /api/creator/api-keys/[id] — revoke a key
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({ where: { clerkUserId: userId } });
  if (!creator) return jsonError("Creator not found", 404);

  const key = await prisma.creatorApiKey.findFirst({
    where: { id, creatorId: creator.id },
  });
  if (!key) return jsonError("API key not found", 404);

  await prisma.creatorApiKey.delete({ where: { id } });
  return jsonSuccess({ deleted: true });
}
