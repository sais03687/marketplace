import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if ("error" in authResult) return authResult.error;
  const { userId } = authResult;

  const formData = await request.formData();
  const packageFile = formData.get("package") as File | null;
  const tagline = formData.get("tagline") as string | null;
  const description = formData.get("description") as string | null;
  const priceStr = formData.get("pricePerMonth") as string | null;
  const runtime = formData.get("runtime") as string | null;

  if (!packageFile) {
    return jsonError("Package file required", 400);
  }

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

  const pricePerMonth = priceStr ? parseInt(priceStr, 10) * 100 : 0; // Convert dollars to cents

  // Create agent + version
  const slug = `agent-${Date.now()}`;
  const agentRuntime = (runtime || "OPENCLAW").toUpperCase() as "OPENCLAW" | "CUSTOM";

  const agent = await prisma.agent.create({
    data: {
      slug,
      name: tagline || "Untitled Agent",
      tagline: tagline || "No description",
      description: description || "",
      category: "GENERAL",
      pricePerMonth,
      modelTier: "SONNET",
      creatorId: creator.id,
      status: "IN_REVIEW",
      currentVersion: "1.0.0",
      runtime: agentRuntime,
    },
  });

  const version = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      version: "1.0.0",
      packageUrl: `upload://${packageFile.name}`,
      vetStatus: "PENDING",
    },
  });

  // In production: upload to R2, enqueue vet job

  return jsonSuccess({ agent, version }, 201);
}
