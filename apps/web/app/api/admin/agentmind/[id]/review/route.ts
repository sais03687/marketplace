import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAdmin } from "@/lib/api-utils";
import { z } from "zod";

const bodySchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireAdmin();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  // Handle both JSON and form-encoded bodies
  const contentType = request.headers.get("content-type") || "";
  let body: Record<string, unknown>;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await request.formData();
    body = Object.fromEntries(formData.entries());
  } else {
    body = await request.json().catch(() => null) as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return jsonError("Invalid JSON body", 400);
    }
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("Invalid request: decision (APPROVED or REJECTED) required", 400);
  }

  const { decision, note } = parsed.data;

  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id },
  });
  if (!contribution) {
    return jsonError("Contribution not found", 404);
  }
  if (contribution.status !== "PENDING") {
    return jsonError("Contribution already reviewed", 409);
  }

  await prisma.knowledgeContribution.update({
    where: { id },
    data: {
      status: decision,
      reviewNote: note || null,
      reviewedBy: userId,
      reviewedAt: new Date(),
    },
  });

  // If form submission, redirect back to the queue page
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return NextResponse.redirect(new URL("/admin/agentmind", request.url));
  }

  return jsonSuccess({ id, status: decision });
}
