import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { createInbox, setInboxWebhook, sendEmail } from "../clients/agentmail.js";
import {
  createAndStartContainer,
  getContainerPort,
  stopContainer,
  type ContainerEnv,
} from "../clients/docker.js";
import { spawnLocalAgent, stopLocalAgent } from "./local-runner.js";
import { buildApprovalPolicySection } from "../utils/approval-policy-prompt.js";

async function log(
  deploymentId: string,
  step: string,
  status: "started" | "succeeded" | "failed" | "retrying",
  attempt: number,
  durationMs?: number,
  error?: string,
) {
  await prisma.provisioningLog.create({
    data: {
      deploymentId,
      step,
      status,
      attempt,
      durationMs,
      ...(error ? { message: error, errorStack: error } : {}),
    },
  });
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { step: string; deploymentId: string; maxRetries?: number },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? config.maxRetries;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      await log(opts.deploymentId, opts.step, "started", attempt);
      const result = await fn();
      await log(opts.deploymentId, opts.step, "succeeded", attempt, Date.now() - start);
      return result;
    } catch (err: any) {
      const duration = Date.now() - start;
      if (attempt < maxRetries) {
        await log(opts.deploymentId, opts.step, "retrying", attempt, duration, err.message);
        // Exponential backoff: 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
      } else {
        await log(opts.deploymentId, opts.step, "failed", attempt, duration, err.message);
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

async function waitForHealth(host: string, port: number): Promise<void> {
  const deadline = Date.now() + config.healthCheckTimeoutMs;
  while (Date.now() < deadline) {
    try {
      // OpenClaw gateway responds to any request when ready (may return 401/404/200)
      const res = await fetch(`http://${host}:${port}/`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status > 0) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, config.healthCheckIntervalMs));
  }
  throw new Error(`Health check timed out after ${config.healthCheckTimeoutMs}ms`);
}

async function waitForCustomHealth(host: string, port: number): Promise<void> {
  const deadline = Date.now() + config.healthCheckTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/internal/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ok) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, config.healthCheckIntervalMs));
  }
  throw new Error(`Custom health check timed out after ${config.healthCheckTimeoutMs}ms`);
}

export async function provisionJob(deploymentId: string): Promise<void> {
  // 1. Validate deployment exists and is in PROVISIONING state
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: {
      agent: { include: { capabilities: { select: { name: true, description: true } } } },
      company: true,
    },
  });

  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }
  if (deployment.status !== "PROVISIONING") {
    throw new Error(
      `Deployment ${deploymentId} is in ${deployment.status}, expected PROVISIONING`,
    );
  }

  // Look up the matching AgentVersion to get the creator's uploaded package path.
  // This is the critical link: storagePath points to the actual uploaded code/workspace,
  // replacing the hardcoded starter templates.
  const agentVersion = await prisma.agentVersion.findFirst({
    where: {
      agentId: deployment.agentId,
      version: deployment.agentVersion,
      vetStatus: "MANUALLY_APPROVED",
    },
    select: { storagePath: true, manifestData: true },
  });

  const agentName = deployment.agentName;
  const companyName = deployment.company.name;
  const companyDomain = deployment.company.domain;

  // Extract approval policy from autonomyConfig. Shape:
  //   { approvalPolicy: "always"|"external-only"|"risk-based"|"never",
  //     approvalRiskThreshold?: number,
  //     autoApproveList?: string[] | string,
  //     requireApprovalList?: string[] | string }
  // Defaults to "external-only" to match prior hardcoded behavior.
  const ac = (deployment.autonomyConfig ?? {}) as Record<string, unknown>;
  const approvalPolicy = typeof ac.approvalPolicy === "string" ? ac.approvalPolicy : "external-only";
  const approvalRiskThreshold =
    typeof ac.approvalRiskThreshold === "number"
      ? String(ac.approvalRiskThreshold)
      : typeof ac.approvalRiskThreshold === "string"
        ? ac.approvalRiskThreshold
        : "6.0";
  const normalizeList = (v: unknown): string =>
    Array.isArray(v) ? v.map(String).join(",") : typeof v === "string" ? v : "";
  const autoApproveList = normalizeList(ac.autoApproveList);
  const requireApprovalList = normalizeList(ac.requireApprovalList);

  // Render the policy as a markdown section for OpenClaw's AGENTS.md.
  // CUSTOM runtime reads the individual env vars directly via adapter.py;
  // OPENCLAW reads this rendered section at session start (startup.sh
  // appends it to /agent/workspace/AGENTS.md).
  const approvalPolicySection = buildApprovalPolicySection(
    ac,
    companyDomain,
  );

  let agentEmail: string;
  let inboxId: string | undefined;

  // 2. Create AgentMail inbox
  try {
    const slug = deployment.agent.slug;
    const companySlug = companyName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    const username = `${slug}-${companySlug}`;

    const inbox = await withRetry(
      () => createInbox(username, "agentmail.to"),
      { step: "create_inbox", deploymentId },
    );
    agentEmail = inbox.email_address;
    inboxId = inbox.id;
  } catch (err: any) {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "ERROR" },
    });
    throw err;
  }

  // 3. Create container or local process
  let containerName: string | undefined;
  let healthPort: number;
  let healthHost = "localhost";

  const containerEnv: ContainerEnv = {
    DEPLOYMENT_ID: deploymentId,
    AGENT_ID: deployment.agentId,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    GEMINI_API_KEY: config.geminiApiKey,
    AGENTMAIL_API_KEY: config.agentMailApiKey,
    AGENT_EMAIL: agentEmail,
    AGENT_NAME: agentName,
    COMPANY_NAME: companyName,
    COMPANY_DOMAIN: companyDomain,
    MARKETPLACE_APPROVAL_WEBHOOK: config.approvalWebhookUrl.replace("localhost", "host.docker.internal"),
    MARKETPLACE_URL: config.approvalWebhookUrl.replace("localhost", "host.docker.internal"),
    APPROVAL_WEBHOOK_TOKEN: config.approvalWebhookToken,
    MODEL: deployment.agent.modelTier,
    WEEKLY_DIGEST_EMAIL: deployment.weeklyDigestEmail || "",
    LLM_API_KEY: config.llmApiKey,
    LLM_BASE_URL: config.llmBaseUrl,
    LLM_MODEL: config.llmModel,
    APPROVAL_POLICY: approvalPolicy,
    APPROVAL_RISK_THRESHOLD: approvalRiskThreshold,
    AUTO_APPROVE_LIST: autoApproveList,
    REQUIRE_APPROVAL_LIST: requireApprovalList,
    APPROVAL_POLICY_SECTION: approvalPolicySection,
  };

  const runtime = deployment.agent.runtime || "OPENCLAW";

  try {
    if (runtime === "CUSTOM") {
      // Custom runtime: always Docker, regardless of RUNNER_MODE
      const { spawnCustomAgent } = await import("./custom-runner.js");
      const { resolve } = await import("node:path");
      // Resolve the creator's actual package — fall back to starter template for seed data
      const pkgPath = agentVersion?.storagePath
        ? resolve(config.webAppRoot, agentVersion.storagePath)
        : resolve(config.customStarterPath);

      const result = await withRetry(
        () => spawnCustomAgent(deploymentId, containerEnv, pkgPath),
        { step: "spawn_custom_agent", deploymentId },
      );
      containerName = `http://localhost:${result.port}`;
      healthPort = result.port;
    } else if (config.runnerMode === "docker") {
      const cName = `agent-${deployment.agent.slug}-${deploymentId.slice(0, 8)}`;
      const { resolve } = await import("node:path");

      // If creator package exists, bind-mount it as the workspace
      const creatorPkgPath = agentVersion?.storagePath
        ? resolve(config.webAppRoot, agentVersion.storagePath)
        : null;
      const volumeBinds = creatorPkgPath
        ? [`${creatorPkgPath}:/agent/workspace:ro`]  // read-only mount
        : [];

      const result = await withRetry(
        () => createAndStartContainer(cName, containerEnv, volumeBinds),
        { step: "create_container", deploymentId },
      );
      containerName = result.containerName;
      healthPort = await getContainerPort(containerName);
    } else {
      // Local mode: spawn a child process (OpenClaw only)
      const { resolve } = await import("node:path");
      const packageOverride = agentVersion?.storagePath
        ? resolve(config.webAppRoot, agentVersion.storagePath)
        : undefined;

      const result = await withRetry(
        () => spawnLocalAgent(deploymentId, containerEnv, packageOverride),
        { step: "spawn_local_agent", deploymentId },
      );
      containerName = result.processLabel;
      healthPort = result.port;
    }
  } catch (err: any) {
    // Clean up inbox on container failure
    if (inboxId) {
      try {
        const { deleteInbox } = await import("../clients/agentmail.js");
        await deleteInbox(inboxId);
      } catch {
        // best-effort cleanup
      }
    }
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "ERROR" },
    });
    throw err;
  }

  // 4. Wait for health check
  if (runtime === "CUSTOM") {
    await withRetry(
      () => waitForCustomHealth(healthHost, healthPort),
      { step: "health_check", deploymentId },
    );
  } else {
    await withRetry(
      () => waitForHealth(healthHost, healthPort),
      { step: "health_check", deploymentId },
    );
  }

  // 5. Set AgentMail webhook so inbound emails reach the agent container
  if (inboxId) {
    const containerUrl = containerName?.startsWith("http")
      ? containerName
      : `http://${healthHost}:${healthPort}`;
    try {
      await setInboxWebhook(inboxId, `${containerUrl}/hooks/agentmail`);
    } catch (err: any) {
      console.warn(`[provision] Failed to set inbox webhook: ${err.message}`);
      // Non-fatal: agent can still send outbound email, just won't receive inbound
    }
  }

  // 6. Update deployment to ONBOARDING
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: "ONBOARDING",
      onboardingState: "INTERVIEW",
      containerName,
      agentEmail,
      agentEmailInboxId: inboxId,
    },
  });

  // 7. Send standardized intro email (platform-side, no LLM needed)
  const managerEmail = deployment.weeklyDigestEmail || `admin@${deployment.company.domain}`;

  const capabilities = deployment.agent.capabilities;
  const capList = capabilities.length > 0
    ? capabilities.map((c) => `  - ${c.name}: ${c.description}`).join("\n")
    : "  - Email management, research, and task execution";

  const googleLine = config.googleServiceAccountEmail
    ? `\nI also have access to Google Workspace. To share Google Drive files, Sheets, or Docs with me, share them with: ${config.googleServiceAccountEmail}\n`
    : "";

  const introText = [
    `Hi there,`,
    ``,
    `I'm ${agentName}, your new AI employee at ${companyName}. I've just been set up and I'm ready to start working with you.`,
    ``,
    `Here's what I can help with:`,
    capList,
    ``,
    `You can reach me anytime by emailing ${agentEmail}.`,
    googleLine,
    `What would you like me to focus on first? Just reply to this email and I'll get started.`,
    ``,
    `Best,`,
    agentName,
  ].join("\n");

  await withRetry(
    async () => {
      await sendEmail(
        inboxId || agentEmail,
        managerEmail,
        `Hi from ${agentName} — your new AI employee`,
        introText,
      );
    },
    { step: "send_intro_email", deploymentId },
  );

  // 8. Send context to the agent so it knows who it is for subsequent conversations
  const onboardingMessage = [
    `You are ${agentName}, an AI employee at ${companyName}.`,
    `Your email address is ${agentEmail}.`,
    `The hiring manager's email is ${managerEmail}.`,
    ...(config.googleServiceAccountEmail
      ? [
          `\nYou also have a Google Workspace identity for file access: ${config.googleServiceAccountEmail}`,
          `Team members can share Google Drive files, Sheets, and Docs with that address so you can read and edit them.`,
        ]
      : []),
    `\nYou have already sent an introduction email. Wait for the manager to reply, then assist them with whatever they need.`,
  ].join("\n");

  await withRetry(
    async () => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (runtime !== "CUSTOM") {
        headers["Authorization"] = `Bearer ${config.openclawHooksToken}`;
      }

      const res = await fetch(`http://${healthHost}:${healthPort}/hooks/agent`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: onboardingMessage,
          name: "Onboarding",
          wakeMode: "now",
          deliver: false,
          sessionKey: "hook:onboarding",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Onboarding trigger failed: ${res.status} ${text}`);
      }
    },
    { step: "trigger_onboarding", deploymentId },
  );

  await log(deploymentId, "provision_complete", "succeeded", 1);
  console.log(
    `[provision] Deployment ${deploymentId} provisioned: agent=${agentEmail} container=${containerName}`,
  );
}
