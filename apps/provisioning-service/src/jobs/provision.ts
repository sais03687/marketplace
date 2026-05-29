import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { createInbox, setInboxWebhook } from "../clients/agentmail.js";
import {
  createAndStartContainer,
  getContainerPort,
  stopContainer,
  type ContainerEnv,
} from "../clients/docker.js";
import { spawnLocalAgent, stopLocalAgent } from "./local-runner.js";
import { buildApprovalPolicySection } from "../utils/approval-policy-prompt.js";
import { createDeploymentServiceAccount } from "../clients/google-iam.js";
import { createGoogleWorkspaceUser, setupGmailForwarding } from "../clients/google-workspace.js";
import { createMicrosoftUser, setupMicrosoftInboxWebhook } from "../clients/microsoft-workspace.js";
import { isBlobStoragePath, downloadBlobPackage } from "../utils/blob-download.js";

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

  // Optional heartbeat: read from the agent's manifest if the creator opted in.
  const manifest = agentVersion?.manifestData as Record<string, unknown> | null | undefined;
  const heartbeatIntervalHours: number | undefined = (() => {
    const hb = manifest?.heartbeat as Record<string, unknown> | undefined;
    if (!hb) return undefined;
    const h = typeof hb.intervalHours === "number" ? hb.intervalHours : 6;
    return Math.min(Math.max(Math.round(h), 1), 24);
  })();

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

  // 2a. Provision workspace identity (Google Workspace or Microsoft 365).
  // The platform owns a single org/tenant; users are created programmatically here.
  // Buyer selects Google or Microsoft during hire — no manual setup required.
  const workspaceProvider = (deployment as any).workspaceProvider as string ?? "NONE";
  const agentSlug = deployment.agent.slug;
  const companySlug = companyName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const usernameSuffix = deploymentId.slice(-8);
  let workspaceEmail: string | undefined;
  let workspaceUserId: string | undefined;

  if (workspaceProvider === "GOOGLE" && config.googleWorkspaceSaKey) {
    try {
      const username = `${agentSlug}-${companySlug}-${usernameSuffix}`;
      const user = await withRetry(
        () => createGoogleWorkspaceUser(username, agentName),
        { step: "create_workspace_user_google", deploymentId },
      );
      workspaceEmail = user.email;
      workspaceUserId = user.id;
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { workspaceEmail: user.email, workspaceUserId: user.id },
      });
      console.log(`[provision] Google Workspace user created: ${user.email}`);
    } catch (err: any) {
      console.warn(`[provision] Google Workspace user creation failed: ${err.message}`);
    }
  } else if (workspaceProvider === "MICROSOFT" && config.microsoftTenantId) {
    try {
      const username = `${agentSlug}-${companySlug}-${usernameSuffix}`;
      const user = await withRetry(
        () => createMicrosoftUser(username, agentName),
        { step: "create_workspace_user_microsoft", deploymentId },
      );
      workspaceEmail = user.email;
      workspaceUserId = user.id;
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { workspaceEmail: user.email, workspaceUserId: user.id },
      });
      console.log(`[provision] Microsoft 365 user created: ${user.email}`);
    } catch (err: any) {
      console.warn(`[provision] Microsoft 365 user creation failed: ${err.message}`);
    }
  } else if (workspaceProvider === "NONE" || !workspaceProvider) {
    // Legacy path: use per-deployment GCP IAM SA if configured
    const iamKey = config.gcpIamKey || config.googleServiceAccountKey;
    if (config.gcpProjectId && iamKey) {
      try {
        const sa = await withRetry(
          () => createDeploymentServiceAccount(
            deploymentId,
            deployment.agent.slug,
            config.gcpProjectId,
            iamKey,
          ),
          { step: "create_service_account", deploymentId },
        );
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            deploymentServiceAccountEmail: sa.email,
            deploymentServiceAccountKey: sa.privateKeyJson,
          },
        });
        console.log(`[provision] Legacy service account created: ${sa.email}`);
      } catch (err: any) {
        console.warn(`[provision] Service account creation failed, using platform SA: ${err.message}`);
      }
    }
  }

  // Re-fetch deployment to get updated SA fields for legacy path env var resolution
  const deploymentRefreshed = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { deploymentServiceAccountEmail: true, deploymentServiceAccountKey: true },
  });
  const effectiveGoogleSAEmail = deploymentRefreshed?.deploymentServiceAccountEmail || config.googleServiceAccountEmail;
  const effectiveGoogleSAKey = deploymentRefreshed?.deploymentServiceAccountKey || config.googleServiceAccountKey;

  let agentEmail: string;
  let inboxId: string | undefined;

  // 2. Create AgentMail inbox
  try {
    const slug = deployment.agent.slug;
    const companySlug = companyName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    // Include a short deployment-ID suffix so multiple deployments of the same
    // agent at the same company each get a distinct inbox.
    const depSuffix = deploymentId.slice(-12);
    const username = `${slug}-${companySlug}-${depSuffix}`;

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

  // 2b. Set up Gmail forwarding from workspace address → Agentmail inbox (Google path only)
  if (workspaceProvider === "GOOGLE" && workspaceEmail && inboxId) {
    try {
      await withRetry(
        () => setupGmailForwarding(workspaceEmail!, agentEmail, inboxId!),
        { step: "setup_gmail_forwarding", deploymentId },
      );
      console.log(`[provision] Gmail forwarding set up: ${workspaceEmail} → ${agentEmail}`);
    } catch (err: any) {
      // Non-fatal: agent can still receive email via Agentmail directly
      console.warn(`[provision] Gmail forwarding setup failed: ${err.message}`);
    }
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
    ...(deployment.portalToken
      ? { PORTAL_TOKEN: deployment.portalToken }
      : {}),
    ...(heartbeatIntervalHours !== undefined
      ? { HEARTBEAT_INTERVAL_HOURS: String(heartbeatIntervalHours) }
      : {}),
    // New workspace identity vars (Google Workspace or Microsoft 365)
    ...(workspaceProvider !== "NONE" && workspaceEmail
      ? { WORKSPACE_PROVIDER: workspaceProvider, WORKSPACE_EMAIL: workspaceEmail }
      : {}),
    ...(workspaceProvider === "GOOGLE" && config.googleWorkspaceSaKey
      ? { GOOGLE_WORKSPACE_SA_KEY: config.googleWorkspaceSaKey }
      : {}),
    ...(workspaceProvider === "MICROSOFT"
      ? {
          MICROSOFT_TENANT_ID: config.microsoftTenantId,
          MICROSOFT_CLIENT_ID: config.microsoftClientId,
          MICROSOFT_CLIENT_SECRET: config.microsoftClientSecret,
        }
      : {}),
    // Legacy Google SA vars — only injected for NONE/legacy deployments that have old SA fields
    ...(workspaceProvider === "NONE" && effectiveGoogleSAEmail
      ? { GOOGLE_SERVICE_ACCOUNT_EMAIL: effectiveGoogleSAEmail }
      : {}),
    ...(workspaceProvider === "NONE" && effectiveGoogleSAKey
      ? { GOOGLE_SERVICE_ACCOUNT_KEY: effectiveGoogleSAKey }
      : {}),
  };

  const runtime = deployment.agent.runtime || "OPENCLAW";

  // Hoisted so both the catch block and the post-try cleanup can access them.
  let resolvedPkgPath: string | null = null;
  let tempPkgDir: string | null = null;

  try {
    // Resolve the agent package path — either from blob storage or local disk.
    // Blob paths (e.g. "packages/langchain-ops/1.0.0/") are downloaded to a
    // temp directory; local paths are resolved relative to WEB_APP_ROOT.
    if (agentVersion?.storagePath) {
      if (isBlobStoragePath(agentVersion.storagePath)) {
        tempPkgDir = await downloadBlobPackage(agentVersion.storagePath);
        resolvedPkgPath = tempPkgDir;
      } else {
        const { resolve } = await import("node:path");
        resolvedPkgPath = resolve(config.webAppRoot, agentVersion.storagePath);
      }
    }

    if (runtime === "CUSTOM") {
      const { spawnCustomAgent } = await import("./custom-runner.js");
      const { resolve } = await import("node:path");
      const pkgPath = resolvedPkgPath ?? resolve(config.customStarterPath);

      const result = await withRetry(
        () => spawnCustomAgent(deploymentId, containerEnv, pkgPath, inboxId),
        { step: "spawn_custom_agent", deploymentId },
      );
      containerName = `http://localhost:${result.port}`;
      healthPort = result.port;
    } else if (config.runnerMode === "docker") {
      const cName = `agent-${deployment.agent.slug}-${deploymentId.slice(0, 8)}`;

      // Bind-mount the package as the workspace (read-only)
      const volumeBinds = resolvedPkgPath
        ? [`${resolvedPkgPath}:/agent/workspace:ro`]
        : [];

      const result = await withRetry(
        () => createAndStartContainer(cName, containerEnv, volumeBinds),
        { step: "create_container", deploymentId },
      );
      containerName = result.containerName;
      healthPort = await getContainerPort(containerName);
    } else {
      // Local mode: spawn a child process (OpenClaw only)
      const result = await withRetry(
        () => spawnLocalAgent(deploymentId, containerEnv, resolvedPkgPath ?? undefined, inboxId),
        { step: "spawn_local_agent", deploymentId },
      );
      containerName = `http://localhost:${result.port}`;
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
    // Clean up temp package dir on failure
    if (tempPkgDir) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(tempPkgDir, { recursive: true, force: true });
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

  // 4b. Set up Microsoft Graph inbox webhook (Microsoft path only)
  if (workspaceProvider === "MICROSOFT" && workspaceUserId) {
    try {
      const sub = await withRetry(
        () => setupMicrosoftInboxWebhook(
          workspaceUserId!,
          deploymentId,
          `${config.approvalWebhookUrl}/webhooks/microsoft`,
        ),
        { step: "setup_microsoft_webhook", deploymentId },
      );
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { msGraphSubId: sub.subscriptionId },
      });
      console.log(`[provision] Microsoft Graph webhook registered: ${sub.subscriptionId}`);
    } catch (err: any) {
      console.warn(`[provision] Microsoft Graph webhook setup failed: ${err.message}`);
    }
  }

  // 5. Set AgentMail webhook so inbound emails reach the agent container
  if (inboxId) {
    const containerUrl = containerName?.startsWith("http")
      ? containerName
      : `http://${healthHost}:${healthPort}`;
    try {
      await setInboxWebhook(inboxId, `${containerUrl}/hooks/agentmail`, agentName);
    } catch (err: any) {
      console.warn(`[provision] Failed to set inbox webhook: ${err.message}`);
      // Non-fatal: agent can still send outbound email, just won't receive inbound
    }
  }

  // 5b. Spawn email poller for Docker-OpenClaw mode.
  // Local mode and Custom mode already start their pollers inside their runners.
  // Docker-OpenClaw relies on the webhook set above, but that webhook points to
  // localhost which AgentMail's cloud servers cannot reach in development.
  // A poller is the reliable fallback for all environments.
  if (runtime !== "CUSTOM" && config.runnerMode === "docker") {
    const { startPoller } = await import("./poller-manager.js");
    startPoller({
      deploymentId,
      agentEmail,
      inboxId,
      agentId: deployment.agentId,
      gatewayUrl: `http://127.0.0.1:${healthPort}`,
      hooksToken: config.openclawHooksToken,
      marketplaceUrl: config.approvalWebhookUrl,
    });
  }

  // 6. Update deployment to ONBOARDING.
  // Preserve OBSERVATION if answers were collected during the hire wizard —
  // don't regress back to INTERVIEW.
  const hasHireAnswers = !!(deployment as any).onboardingData;
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      status: "ONBOARDING",
      onboardingState: hasHireAnswers ? "OBSERVATION" : "INTERVIEW",
      containerName,
      agentEmail,
      agentEmailInboxId: inboxId,
      approvalWebhookToken: config.approvalWebhookToken,
    },
  });

  // 7. Send context to the agent so it knows who it is for subsequent conversations.
  // The formatted introduction email to the manager is sent explicitly by the hiring
  // manager clicking "Send Introduction Email" in the onboarding panel — not auto-sent here.
  const managerEmail = deployment.weeklyDigestEmail || `admin@${deployment.company.domain}`;
  // If the hiring manager answered onboarding questions during the hire wizard,
  // include those answers so the agent can configure its knowledge base immediately.
  const hireAnswers = (deployment as any).onboardingData as Record<string, string> | null | undefined;
  const answersSection = hireAnswers && Object.keys(hireAnswers).length > 0
    ? [
        "\nYour hiring manager answered the following onboarding questions during setup:",
        "",
        ...Object.entries(hireAnswers).map(([k, v]) => `  ${k}: ${v}`),
        "\nPlease use these answers to configure your working style, approval preferences, and memory.",
      ].join("\n")
    : "";

  const onboardingMessage = [
    `You are ${agentName}, an AI employee at ${companyName}.`,
    `Your email address is ${agentEmail}.`,
    `The hiring manager's email is ${managerEmail}.`,
    ...(workspaceEmail
      ? [
          `\nYou have your own workspace identity: ${workspaceEmail}.`,
          workspaceProvider === "GOOGLE"
            ? `Team members can share Google Drive files, Sheets, and Docs with that address, and send you calendar invites.`
            : `Team members can share OneDrive files and Excel workbooks with that address, and send you calendar invites.`,
        ]
      : effectiveGoogleSAEmail
        ? [
            `\nYou also have a Google Workspace identity for file access: ${effectiveGoogleSAEmail}`,
            `Team members can share Google Drive files, Sheets, and Docs with that address so you can read and edit them.`,
          ]
        : []),
    answersSection,
    `\nAn introduction email will be sent to the hiring manager shortly. Once they reply, assist them with whatever they need.`,
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

  // Clean up temp package dir now that the container has it bind-mounted or copied
  if (tempPkgDir) {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(tempPkgDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  await log(deploymentId, "provision_complete", "succeeded", 1);
  console.log(
    `[provision] Deployment ${deploymentId} provisioned: agent=${agentEmail} container=${containerName}`,
  );
}
