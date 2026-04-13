import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireAuth } from "@/lib/api-utils";
import { z } from "zod";

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tagline: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(5000).optional(),
  category: z
    .enum([
      "SALES_OPERATIONS",
      "CUSTOMER_SUCCESS",
      "EXECUTIVE_ASSISTANT",
      "RESEARCH",
      "MARKETING_OPS",
      "HR_OPS",
      "FINANCE_OPS",
      "ENGINEERING_OPS",
      "GENERAL",
    ])
    .optional(),
  pricePerMonth: z.number().int().min(0).optional(),
  capabilities: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .optional(),
});

export async function PATCH(
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

  if (!creator) {
    return jsonError("Creator not found", 404);
  }

  const agent = await prisma.agent.findUnique({
    where: { slug },
    include: { capabilities: true },
  });

  if (!agent) {
    return jsonError("Agent not found", 404);
  }

  if (agent.creatorId !== creator.id) {
    return jsonError("Not authorized to edit this agent", 403);
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

  const { capabilities, ...fields } = parsed.data;

  const updated = await prisma.$transaction(async (tx) => {
    const updatedAgent = await tx.agent.update({
      where: { id: agent.id },
      data: fields,
    });

    if (capabilities) {
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
    }

    return tx.agent.findUnique({
      where: { id: agent.id },
      include: { capabilities: true },
    });
  });

  return jsonSuccess(updated);
}
