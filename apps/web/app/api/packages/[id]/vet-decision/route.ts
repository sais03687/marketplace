import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;

  // In production, check admin role
  let decision: string;

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    decision = body.decision;
  } else {
    const formData = await request.formData();
    decision = formData.get("decision") as string;
  }

  if (!decision || !["MANUALLY_APPROVED", "FAILED", "PASSED"].includes(decision)) {
    return jsonError("Invalid decision", 400);
  }

  const version = await prisma.agentVersion.findUnique({
    where: { id },
    include: { agent: true },
  });

  if (!version) {
    return jsonError("Version not found", 404);
  }

  await prisma.agentVersion.update({
    where: { id },
    data: {
      vetStatus: decision as "MANUALLY_APPROVED" | "FAILED" | "PASSED",
      vetNotes: decision === "FAILED" ? "Rejected by admin" : null,
      publishedAt: decision === "MANUALLY_APPROVED" ? new Date() : null,
    },
  });

  // If approved, set agent to LIVE
  if (decision === "MANUALLY_APPROVED") {
    await prisma.agent.update({
      where: { id: version.agentId },
      data: { status: "LIVE" },
    });
  }

  return jsonSuccess({ message: `Decision: ${decision}` });
}
