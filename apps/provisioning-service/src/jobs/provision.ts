import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { createInbox } from "../clients/agentmail.js";
import {
  createAndStartContainer,
  getContainerPort,
  stopContainer,
  type ContainerEnv,
} from "../clients/docker.js";
import { spawnLocalAgent, stopLocalAgent } from "./local-runner.js";

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
    include: { agent: true, company: true },
  });

  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }
  if (deployment.status !== "PROVISIONING") {
    throw new Error(
      `Deployment ${deploymentId} is in ${deployment.status}, expected PROVISIONING`,
    );
  }

  const agentName = deployment.agentName;
  const companyName = deployment.company.name;
  const companyDomain = deployment.company.domain;

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
    APPROVAL_WEBHOOK_TOKEN: config.approvalWebhookToken,
    MODEL: deployment.agent.modelTier,
  };

  const runtime = deployment.agent.runtime || "OPENCLAW";

  try {
    if (runtime === "CUSTOM") {
      // Custom runtime: always Docker, regardless of RUNNER_MODE
      const { spawnCustomAgent } = await import("./custom-runner.js");
      const { resolve } = await import("node:path");
      const pkgPath = resolve(config.customStarterPath);

      const result = await withRetry(
        () => spawnCustomAgent(deploymentId, containerEnv, pkgPath),
        { step: "spawn_custom_agent", deploymentId },
      );
      containerName = `http://localhost:${result.port}`;
      healthPort = result.port;
    } else if (config.runnerMode === "docker") {
      const cName = `agent-${deployment.agent.slug}-${deploymentId.slice(0, 8)}`;
      const result = await withRetry(
        () => createAndStartContainer(cName, containerEnv),
        { step: "create_container", deploymentId },
      );
      containerName = result.containerName;
      healthPort = await getContainerPort(containerName);
    } else {
      // Local mode: spawn a child process (OpenClaw only)
      const result = await withRetry(
        () => spawnLocalAgent(deploymentId, containerEnv),
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

  // 5. Update deployment to ONBOARDING
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: "ONBOARDING",
      onboardingState: "INTERVIEW",
      containerName,
      agentEmail,
    },
  });

  // 6. Trigger onboarding
  const managerEmail = deployment.weeklyDigestEmail || `admin@${deployment.company.domain}`;
  const onboardingMessage = [
    `You are ${agentName}, an AI employee just hired by ${companyName}.`,
    `Your email address is ${agentEmail}.`,
    `The hiring manager's email is ${managerEmail}.`,
    ...(config.googleServiceAccountEmail
      ? [
          `\nYou also have a Google Workspace identity for file access: ${config.googleServiceAccountEmail}`,
          `Team members can share Google Drive files, Sheets, and Docs with that address so you can read and edit them.`,
        ]
      : []),
    `\nPlease introduce yourself by sending an email to ${managerEmail}.`,
    `In your introduction:`,
    `- Greet them warmly and introduce yourself by name`,
    `- Briefly describe what you can help with (email management, research, scheduling${config.googleServiceAccountEmail ? ", Google Docs/Sheets collaboration" : ""})`,
    `- Let them know they can email you at ${agentEmail}`,
    ...(config.googleServiceAccountEmail
      ? [`- Mention that to share Google files with you, they can share with ${config.googleServiceAccountEmail}`]
      : []),
    `- Ask what they'd like you to focus on first`,
    `- Keep it professional but friendly`,
    `\nIMPORTANT: Use the email_send tool directly to send this introduction email.`,
    `Do NOT use queue_approval for this — introduction emails are pre-approved.`,
  ].join("\n");

  await withRetry(
    async () => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // OpenClaw requires Bearer auth; custom adapter is internal (no auth needed)
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
