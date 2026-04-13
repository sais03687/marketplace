import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { z } from "zod";

export async function GET() {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) {
    return jsonError("Creator not found", 404);
  }

  return jsonSuccess({
    id: creator.id,
    displayName: creator.displayName,
    email: creator.email,
  });
}

const patchSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
});

export async function PATCH(request: Request) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const creator = await prisma.creator.findUnique({
    where: { clerkUserId: userId },
  });

  if (!creator) {
    return jsonError("Creator not found", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      `Validation failed: ${parsed.error.errors.map((e) => e.message).join(", ")}`,
      400,
    );
  }

  const { displayName, email } = parsed.data;

  // Check email uniqueness if changing
  if (email && email !== creator.email) {
    const existing = await prisma.creator.findUnique({
      where: { email },
    });
    if (existing) {
      return jsonError("Email already in use by another creator", 409);
    }
  }

  const updated = await prisma.creator.update({
    where: { id: creator.id },
    data: {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(email !== undefined ? { email } : {}),
    },
  });

  return jsonSuccess({
    id: updated.id,
    displayName: updated.displayName,
    email: updated.email,
  });
}
