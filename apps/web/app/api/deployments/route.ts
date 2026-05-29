import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  parseBody,
  requireOrg,
} from "@/lib/api-utils";
import { Queue } from "bullmq";
import { getStripe } from "@/lib/stripe";

const createDeploymentSchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1).max(100),
  roleTitle: z.string().optional(),
  weeklyDigestEmail: z.string().email().optional(),
  approvalManagerEmail: z.string().email().optional(),
  slackBotToken: z.string().optional(),
  slackAppToken: z.string().optional(),
  // Onboarding answers collected during the hire wizard (skips INTERVIEW stage)
  onboardingAnswers: z.record(z.string()).optional(),
  workspaceProvider: z.enum(["GOOGLE", "MICROSOFT", "NONE"]).optional().default("NONE"),
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002";

let provisionQueue: Queue | null = null;
function getProvisionQueue() {
  if (!provisionQueue) {
    const redisUrl = new URL(process.env.REDIS_URL || "redis://localhost:6379");
    provisionQueue = new Queue("provisioning", {
      connection: {
        host: redisUrl.hostname,
        port: parseInt(redisUrl.port || "6379", 10),
        username: redisUrl.username || undefined,
        password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
        tls: redisUrl.protocol === "rediss:" ? {} : undefined,
      },
    });
  }
  return provisionQueue;
}

export async function GET(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const url = new URL(request.url);
  const includeApprovals = url.searchParams.get("includeApprovals") === "true";

  const deployments = await prisma.deployment.findMany({
    where: { companyId: company.id, status: { not: "PENDING_PAYMENT" } },
    include: {
      agent: true,
      ...(includeApprovals ? { approvals: { orderBy: { createdAt: "desc" } } } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess(deployments);
}

export async function POST(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const parsed = await parseBody(request, createDeploymentSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const agent = await prisma.agent.findUnique({
    where: { id: data.agentId },
  });

  if (!agent || agent.status !== "LIVE") {
    return jsonError("Agent not found or not available", 404);
  }

  // Process onboarding answers (collected during hire wizard) into autonomyConfig
  // so the provisioning service can configure the agent container correctly
  // from the start — no separate onboarding INTERVIEW stage needed.
  const autonomyConfig: Record<string, unknown> = {};
  const onboardingState =
    data.onboardingAnswers && Object.keys(data.onboardingAnswers).length > 0
      ? "OBSERVATION"
      : "INTERVIEW";

  if (data.onboardingAnswers) {
    const a = data.onboardingAnswers;

    const toList = (v: unknown): string[] => {
      if (typeof v === "string") {
        return v.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
      }
      return [];
    };

    if (typeof a.approval_policy === "string" && a.approval_policy.trim()) {
      autonomyConfig.approvalPolicy = a.approval_policy.trim();
    }
    const autoList = toList(a.auto_approve_list);
    if (autoList.length) autonomyConfig.autoApproveList = autoList;
    const reqList = toList(a.require_approval_list);
    if (reqList.length) autonomyConfig.requireApprovalList = reqList;

    if (typeof a.agentmind_enabled === "string") {
      if (a.agentmind_enabled === "no") {
        autonomyConfig.agentMindEnabled = false;
        autonomyConfig.agentMindAutoApprove = false;
      } else if (a.agentmind_enabled === "no_auto") {
        autonomyConfig.agentMindEnabled = true;
        autonomyConfig.agentMindAutoApprove = false;
      } else {
        autonomyConfig.agentMindEnabled = true;
        autonomyConfig.agentMindAutoApprove = true;
      }
    }
  }

  const deployment = await prisma.deployment.create({
    data: {
      companyId: company.id,
      agentId: agent.id,
      agentVersion: agent.currentVersion || "1.0.0",
      agentName: data.agentName,
      weeklyDigestEmail: data.weeklyDigestEmail,
      slackBotToken: data.slackBotToken,
      slackAppToken: data.slackAppToken,
      autonomyConfig: autonomyConfig as any,
      workspaceProvider: data.workspaceProvider,
      onboardingState,
      ...(data.onboardingAnswers && Object.keys(data.onboardingAnswers).length > 0
        ? { onboardingData: data.onboardingAnswers as any }
        : {}),
      // Stay PENDING_PAYMENT until Stripe confirms — avoids showing ghost deployments
      // in the dashboard for abandoned checkouts. Webhook moves this to PROVISIONING.
      status: getStripe() ? "PENDING_PAYMENT" : "PROVISIONING",
    },
  });

  const stripe = getStripe();

  if (stripe) {
    // Ensure the company has a Stripe customer
    let stripeCustomerId = company.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        name: company.name,
        metadata: { companyId: company.id },
      });
      stripeCustomerId = customer.id;
      await prisma.company.update({
        where: { id: company.id },
        data: { stripeCustomerId },
      });
    }

    // Create a price dynamically for this agent's monthly subscription
    const price = await stripe.prices.create({
      unit_amount: agent.pricePerMonth,
      currency: "usd",
      recurring: { interval: "month" },
      product_data: {
        name: agent.name,
        metadata: { agentId: agent.id },
      },
    });

    // Create Stripe Checkout session — buyer pays before provisioning starts
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { deploymentId: deployment.id },
      success_url: `${APP_URL}/dashboard/billing/success?session_id={CHECKOUT_SESSION_ID}&deploymentId=${deployment.id}`,
      cancel_url: `${APP_URL}/browse`,
    });

    return jsonSuccess({ checkoutUrl: session.url, deploymentId: deployment.id }, 201);
  }

  // Dev/no-Stripe fallback: enqueue provisioning directly
  try {
    await getProvisionQueue().add("provision", {
      type: "provision",
      deploymentId: deployment.id,
    });
  } catch {
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: "ERROR" },
    });
    return jsonError("Failed to enqueue provisioning job", 503);
  }

  return jsonSuccess({ checkoutUrl: null, deploymentId: deployment.id, deployment }, 201);
}
