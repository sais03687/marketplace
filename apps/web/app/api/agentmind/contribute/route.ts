import { prisma } from "@/lib/db";
import { requireDeploymentToken } from "@/lib/deployment-token";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { runGuardrails, contributionInputSchema } from "@/lib/agentmind/guardrails";
import { z } from "zod";
import {
  embedTexts,
  findNeighbours,
  isFounded,
  reviewDueDate,
  CLUSTER_THRESHOLD,
  DUPLICATE_THRESHOLD,
  type NeighbourHit,
} from "@/lib/agentmind-embedding";

const bodySchema = z.object({
  deploymentId: z.string().min(1),
  type: z.enum(["CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"]),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  context: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(50)).min(1).max(10),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return jsonError(`Validation failed: ${details}`, 400);
  }

  const { deploymentId, type, title, content, context, tags } = parsed.data;

  // Validate deployment exists and is active
  // Authenticated as the deployment it claims to be, not merely naming
  // one. This checked existence only, so an unauthenticated caller could
  // act as any active deployment - and what AgentMind does with that is
  // hand it to every other company's agent.
  const authed = await requireDeploymentToken(request, deploymentId);
  if ("error" in authed) return authed.error;
  const { deployment } = authed;

  // AgentMind opt-out check
  const ac = (deployment.autonomyConfig ?? {}) as Record<string, unknown>;
  if (ac.agentMindEnabled === false) {
    return jsonError("AgentMind is disabled for this deployment", 403);
  }

  // Memory tier gate: only ACTIVE deployments with at least one resolved approval
  if (deployment.status !== "ACTIVE") {
    return jsonError("Only active deployments can contribute knowledge", 403);
  }

  const resolvedApproval = await prisma.approval.findFirst({
    where: {
      deploymentId,
      status: { in: ["APPROVED", "EDITED"] },
    },
  });
  if (!resolvedApproval) {
    return jsonError(
      "Deployment must have at least one resolved approval before contributing",
      403,
    );
  }

  // Exact-title duplicate. Kept, but it was never enough on its own: the seven
  // lessons that taught the agent to refuse emailing its own manager all had
  // different titles for the same rule, so not one of them deduped here.
  const existing = await prisma.knowledgeContribution.findFirst({
    where: {
      agentId: deployment.agentId,
      type,
      title: { equals: title, mode: "insensitive" },
    },
  });
  if (existing) {
    return jsonSuccess({ id: existing.id, status: existing.status, duplicate: true });
  }

  // Run guardrails
  const guardrailResult = runGuardrails({ title, content, type, tags, context });
  if (!guardrailResult.passed) {
    return jsonError(
      guardrailResult.rejectionReason || "Content rejected by guardrails",
      422,
    );
  }

  // Embed before deciding, not after. The vector is what makes the semantic
  // duplicate check possible, and it is needed on the row regardless.
  const [embedding] =
    (await embedTexts([`${title}\n${guardrailResult.sanitizedContent}`])) ?? [];

  // Semantic neighbours among this agent's existing lessons. PENDING rows count:
  // a topic with three entries already awaiting review does not need a fourth.
  let neighbours: NeighbourHit[] = [];
  if (embedding?.length) {
    const siblings = await prisma.knowledgeContribution.findMany({
      where: { agentId: deployment.agentId, status: { in: ["APPROVED", "PENDING"] } },
      select: { id: true, title: true, embedding: true },
    });
    neighbours = findNeighbours(embedding, siblings, CLUSTER_THRESHOLD);

    // Same lesson, different words. Return the existing row exactly as the title
    // match above does, so a re-phrasing does not become a second entry.
    const twin = neighbours.find((n) => n.score >= DUPLICATE_THRESHOLD);
    if (twin) {
      const row = await prisma.knowledgeContribution.findUnique({
        where: { id: twin.id },
        select: { id: true, status: true },
      });
      if (row) {
        console.log(
          `[agentmind] "${title}" is ${twin.score.toFixed(3)} similar to "${twin.title}" — returning existing`,
        );
        return jsonSuccess({ id: row.id, status: row.status, duplicate: true }, 200);
      }
    }
  }

  // Resolve initial status based on deployment's agentMind preference.
  //
  // CORRECTION is held for review whatever the buyer set, because it is the class
  // that goes stale. A correction encodes "when X happens, do Y" — it is a record
  // of a failure, and a failure is exactly the thing that stops being true once
  // somebody fixes it. One recorded that a 501 from Excel meant the workbook API
  // was unavailable and the agent should apologise and offer alternatives; the
  // real cause was a 253-byte file that was not a workbook, since replaced. It
  // stayed approved, describing the opposite of the truth about the agent's main
  // job. The other three types describe durable things — a pattern, a template, a
  // recipe — and keep flowing as the buyer configured.
  const autoApprove = ac.agentMindAutoApprove !== false; // default true

  // Two further reasons to hold a lesson for a human, whatever the buyer set.
  //
  // "cluster" — the topic already has two or more near-identical entries. One
  // lesson about external sharing is knowledge; seven is a pile-up that crowds
  // out everything else in every search and reinforces itself.
  //
  // "unfounded" — the lesson makes claims about what the platform does, but the
  // run that wrote it never asked the platform anything (no `Triggered by:` in
  // its provenance). That is the agent generalising from its own reasoning, and
  // it is exactly how one refusal became a standing policy.
  let flagReason: string | null = null;
  if (neighbours.length >= 2) {
    flagReason = "cluster";
  } else if (!isFounded(context)) {
    flagReason = "unfounded";
  }

  const initialStatus =
    autoApprove && type !== "CORRECTION" && !flagReason ? "APPROVED" : "PENDING";

  if (flagReason) {
    console.log(
      `[agentmind] Holding "${title}" for review (${flagReason})` +
        (flagReason === "cluster"
          ? `: ${neighbours.length} similar — ${neighbours
              .slice(0, 3)
              .map((n) => `${n.title} ${n.score.toFixed(2)}`)
              .join("; ")}`
          : ""),
    );
  }

  const contribution = await prisma.knowledgeContribution.create({
    data: {
      agentId: deployment.agentId,
      deploymentId,
      type,
      title,
      content: guardrailResult.sanitizedContent,
      rawContent: content,
      context: context || null,
      tags,
      sanitizationLog: guardrailResult.log,
      status: initialStatus,
      flagReason,
      // Only dated when it goes live. A PENDING row is already in front of a
      // human, so a review date on it would mean nothing.
      reviewDueAt: initialStatus === "APPROVED" ? reviewDueDate(type) : null,
      embedding: embedding ?? [],
      embeddedAt: embedding?.length ? new Date() : null,
    },
  });

  return jsonSuccess(
    { id: contribution.id, status: contribution.status, flagReason },
    201,
  );
}
