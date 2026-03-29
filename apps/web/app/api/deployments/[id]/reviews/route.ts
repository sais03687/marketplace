import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  parseBody,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";

const createReviewSchema = z.object({
  rating: z.number().min(1).max(5),
  headline: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const reviews = await prisma.review.findMany({
    where: { deploymentId: id },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess(reviews);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  // 14-day gate
  const daysSinceCreated = Math.floor(
    (Date.now() - new Date(deployment.createdAt).getTime()) /
      (1000 * 60 * 60 * 24),
  );

  if (daysSinceCreated < 14) {
    return jsonError(
      `You can leave a review after 14 days (${14 - daysSinceCreated} days remaining)`,
      403,
    );
  }

  // Check for existing review
  const existing = await prisma.review.findFirst({
    where: { deploymentId: id },
  });

  if (existing) {
    return jsonError("Review already submitted for this deployment", 409);
  }

  const parsed = await parseBody(request, createReviewSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const review = await prisma.review.create({
    data: {
      deploymentId: id,
      agentId: deployment.agentId,
      rating: data.rating,
      headline: data.headline,
      body: data.body,
      verifiedHire: true,
    },
  });

  // Update agent average rating
  const allReviews = await prisma.review.findMany({
    where: { agentId: deployment.agentId },
    select: { rating: true },
  });

  const avgRating =
    allReviews.reduce((sum, r) => sum + r.rating, 0) / allReviews.length;

  await prisma.agent.update({
    where: { id: deployment.agentId },
    data: { averageRating: avgRating },
  });

  return jsonSuccess(review, 201);
}
