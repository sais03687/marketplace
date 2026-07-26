import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { createInbox, setInboxWebhook } from "../clients/agentmail.js";
import {
  createAndStartContainer,
  createAgentNetwork,
  removeAgentNetwork,
  getContainerPort,
  stopContainer,
  type ContainerEnv,
} from "../clients/docker.js";
import { spawnMcpSidecars, stopMcpSidecars } from "../mcp/sidecar-manager.js";
import { spawnLocalAgent, stopLocalAgent } from "./local-runner.js";
import { buildApprovalPolicySection } from "../utils/approval-policy-prompt.js";
import { createDeploymentServiceAccount } from "../clients/google-iam.js";
import { createGoogleWorkspaceUser, setupGmailForwarding } from "../clients/google-workspace.js";
import { createMicrosoftUser, setupMicrosoftInboxWebhook, createSharePointFolder, deleteMicrosoftUser, createSharedMailbox, getBuyerDomain, installTeamsAppForTenant } from "../clients/microsoft-workspace.js";
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

export async function provisionJob(
  deploymentId: string,
  /**
   * The status the deployment held before the caller set it to PROVISIONING,
   * which this job requires as an entry condition. A re-provision of a live
   * agent uses it to avoid demoting an ACTIVE deployment back to ONBOARDING.
   */
  statusBefore?: string,
): Promise<void> {
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
  const companyTimezone = deployment.company.timezone || "America/New_York";

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

  // Captured before provisioning mutates anything. The failure path below tears
  // down the resources it provisioned, which is right for a first-time provision
  // and destructive for a re-provision: those resources already belong to a live
  // agent. Anything the deployment already owned must never be deleted by the
  // rollback — a recoverable container conflict once deleted a running agent's
  // mailbox because the rollback could not tell the difference.
  const preExistingWorkspaceUserId = (deployment as any).workspaceUserId as string | null;
  const preExistingInboxId = (deployment as any).agentEmailInboxId as string | null;

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
    const buyerTenantId = (deployment as any).buyerMicrosoftTenantId as string | null;

    if (buyerTenantId) {
      // ── Buyer-org mode: create shared mailbox in buyer's tenant ──
      try {
        const username = `${agentSlug}-${companySlug}-${usernameSuffix}`;
        const mailbox = await withRetry(
          () => createSharedMailbox(buyerTenantId, `${agentName} (Agent)`, username),
          { step: "create_shared_mailbox_buyer", deploymentId },
        );
        workspaceEmail = mailbox.email;
        workspaceUserId = mailbox.id;
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            workspaceEmail: mailbox.email,
            workspaceUserId: mailbox.id,
            buyerMailboxAddress: mailbox.email,
            workspaceScope: "buyer_org",
          },
        });
        console.log(`[provision] Buyer-org shared mailbox created: ${mailbox.email}`);

        // Auto-install Teams app into buyer's org catalog (non-fatal)
        try {
          const { teamsAppId } = await installTeamsAppForTenant(buyerTenantId);
          console.log(`[provision] Teams app installed in buyer org catalog (teamsAppId=${teamsAppId})`);
        } catch (teamsErr: any) {
          console.warn(`[provision] Teams app auto-install failed (non-fatal): ${teamsErr.message}`);
        }
      } catch (err: any) {
        console.warn(`[provision] Buyer-org shared mailbox creation failed: ${err.message}`);
        // Fall back to platform user
        console.log(`[provision] Falling back to platform Microsoft user...`);
        try {
          const username = `${agentSlug}-${companySlug}-${usernameSuffix}`;
          const user = await withRetry(
            () => createMicrosoftUser(username, agentName),
            { step: "create_workspace_user_microsoft_fallback", deploymentId },
          );
          workspaceEmail = user.email;
          workspaceUserId = user.id;
          await prisma.deployment.update({
            where: { id: deploymentId },
            data: {
              workspaceEmail: user.email,
              workspaceUserId: user.id,
              mailboxLocation: "platform",
              workspaceScope: "platform",
            },
          });
          console.log(`[provision] Fallback: platform Microsoft 365 user created: ${user.email}`);
        } catch (fallbackErr: any) {
          console.warn(`[provision] Fallback platform user creation also failed: ${fallbackErr.message}`);
        }
      }
    } else {
      // ── Platform mode: create user in platform tenant (existing behavior) ──
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

  // Workspace identity is created with a deterministic username, so a re-provision
  // of an already-provisioned deployment fails with a conflict. Every branch above
  // only warns on that failure, leaving workspaceEmail undefined — and because the
  // container env below injects WORKSPACE_EMAIL only when it is truthy *in this
  // run*, re-provisioning would silently strip the agent's own address out of its
  // environment. Fall back to what was persisted by the run that first created it.
  if (workspaceProvider !== "NONE" && !workspaceEmail) {
    workspaceEmail = (deployment as any).workspaceEmail ?? undefined;
    workspaceUserId = (deployment as any).workspaceUserId ?? undefined;
    if (workspaceEmail) {
      console.log(`[provision] Reusing existing workspace identity: ${workspaceEmail}`);
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

  // 2. Create AgentMail inbox — only where it will actually be used.
  // A Microsoft deployment receives on its M365 mailbox and sends through the
  // Graph proxy, so an AgentMail inbox is dead weight: a second address for the
  // same agent that nothing polls, and one more thing to keep in sync. Anything
  // provisioned before this keeps the inbox it already has, because
  // deprovision.ts still needs the id to delete it when the agent is fired.
  if (workspaceProvider === "MICROSOFT" && workspaceEmail) {
    agentEmail = workspaceEmail;
    inboxId = preExistingInboxId ?? undefined;
    console.log(
      `[provision] Microsoft workspace — skipping AgentMail inbox, agent address is ${workspaceEmail}`,
    );
  } else {
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
    COMPANY_TIMEZONE: companyTimezone,
    MARKETPLACE_APPROVAL_WEBHOOK: config.approvalWebhookUrl.replace("localhost", "host.docker.internal"),
    MARKETPLACE_URL: config.approvalWebhookUrl.replace("localhost", "host.docker.internal"),
    APPROVAL_WEBHOOK_TOKEN: config.approvalWebhookToken,
    MODEL: deployment.agent.modelTier,
    MANAGER_EMAIL: deployment.managerEmail || "",
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
      ? deployment.buyerMicrosoftTenantId
        ? {
            // Buyer-org mode: agent fetches tokens from provisioning service
            WORKSPACE_SCOPE: "buyer_org",
            TOKEN_ENDPOINT_URL: "http://host.docker.internal:3003/internal/microsoft-token",
            SHAREPOINT_FOLDER: agentSlug,
            // Outlook email via Graph API
            EMAIL_MODE: "outlook",
            OUTLOOK_SEND_URL: "http://host.docker.internal:3003/internal/outlook-send",
          }
        : {
            // Platform-tenant mode: inject secrets directly
            MICROSOFT_TENANT_ID: config.microsoftTenantId,
            MICROSOFT_CLIENT_ID: config.microsoftClientId,
            MICROSOFT_CLIENT_SECRET: config.microsoftClientSecret,
            SHAREPOINT_FOLDER: agentSlug,
            // Outlook email via Graph API
            EMAIL_MODE: "outlook",
            OUTLOOK_SEND_URL: "http://host.docker.internal:3003/internal/outlook-send",
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
  let agentNetworkName: string | null = null;

  // Check if the agent needs MCP sidecars
  const requiredIntegrations: string[] = Array.isArray((manifest as any)?.requiredIntegrations)
    ? (manifest as any).requiredIntegrations
    : [];

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

    // Create isolated Docker network for this deployment (agent + sidecars)
    // Custom runtime also needs a network when MCP sidecars are required.
    if (config.runnerMode === "docker" || (runtime === "CUSTOM" && requiredIntegrations.length > 0)) {
      agentNetworkName = await createAgentNetwork(deploymentId);
    }

    // Spawn MCP sidecars if the agent needs them
    if (requiredIntegrations.length > 0 && agentNetworkName) {
      console.log(`[provision] Spawning MCP sidecars: ${requiredIntegrations.join(", ")}`);
      const mcpSidecars = await spawnMcpSidecars(deploymentId, agentNetworkName, requiredIntegrations);
      // Inject MCP sidecar URLs into the container env
      for (const [integrationType, info] of mcpSidecars) {
        const envKey = `MCP_${integrationType.toUpperCase().replace(/-/g, "_")}_URL`;
        (containerEnv as any)[envKey] = info.internalUrl;
        console.log(`[provision] MCP env: ${envKey}=${info.internalUrl}`);
      }
    }

    if (runtime === "CUSTOM") {
      const { spawnCustomAgent } = await import("./custom-runner.js");
      const { resolve } = await import("node:path");
      const pkgPath = resolvedPkgPath ?? resolve(config.customStarterPath);

      const result = await withRetry(
        () => spawnCustomAgent(deploymentId, containerEnv, pkgPath, inboxId, agentNetworkName ?? undefined),
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
        () => createAndStartContainer(cName, containerEnv, volumeBinds, agentNetworkName ?? undefined),
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
    // Clean up inbox on container failure — but only if this run created it.
    if (inboxId && inboxId !== preExistingInboxId) {
      try {
        const { deleteInbox } = await import("../clients/agentmail.js");
        await deleteInbox(inboxId);
      } catch {
        // best-effort cleanup
      }
    } else if (inboxId) {
      console.log(`[provision] Keeping pre-existing inbox ${inboxId} (not created by this run)`);
    }
    // Clean up M365 user on failure (prevents orphaned licensed users) — again,
    // only one this run created. Deleting a pre-existing user destroys the
    // mailbox of an agent that is still running.
    if (
      workspaceUserId
      && workspaceProvider === "MICROSOFT"
      && workspaceUserId !== preExistingWorkspaceUserId
    ) {
      try {
        await deleteMicrosoftUser(workspaceUserId);
        console.log(`[provision] Cleaned up orphaned M365 user ${workspaceUserId}`);
      } catch {
        // best-effort cleanup
      }
    } else if (workspaceUserId) {
      console.log(
        `[provision] Keeping pre-existing M365 user ${workspaceUserId} (not created by this run)`,
      );
    }
    // Clean up MCP sidecars and network on failure
    if (requiredIntegrations.length > 0) {
      try {
        await stopMcpSidecars(deploymentId);
      } catch {
        // best-effort cleanup
      }
    }
    if (agentNetworkName) {
      try {
        await removeAgentNetwork(deploymentId);
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

  // 4b. Set up Microsoft Graph inbox webhook + SharePoint folder (Microsoft path only)
  if (workspaceProvider === "MICROSOFT" && workspaceUserId) {
    const webhookUrl = `${config.approvalWebhookUrl}/webhooks/microsoft`;
    console.log(`[provision] Registering Microsoft Graph webhook at: ${webhookUrl}`);
    // Wait for M365 user to propagate across Microsoft's directory before subscribing
    await new Promise((r) => setTimeout(r, 20_000));

    // Create per-agent SharePoint folder for file storage (Excel tracker, docs, etc.)
    try {
      await createSharePointFolder(agentSlug);
    } catch (err: any) {
      console.warn(`[provision] SharePoint folder creation failed: ${err.message}`);
    }

    try {
      const sub = await withRetry(
        () => setupMicrosoftInboxWebhook(
          workspaceUserId!,
          deploymentId,
          webhookUrl,
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
      agentId: deployment.agentId,
      gatewayUrl: `http://127.0.0.1:${healthPort}`,
      hooksToken: config.openclawHooksToken,
      marketplaceUrl: config.approvalWebhookUrl,
      outlookEmail: workspaceEmail ?? agentEmail,
    });
  }

  // 6. Update deployment to ONBOARDING.
  // Preserve OBSERVATION if answers were collected during the hire wizard —
  // don't regress back to INTERVIEW.
  const hasHireAnswers = !!(deployment as any).onboardingData;
  // The deployment is necessarily PROVISIONING by now — that is this job's entry
  // condition — so the caller has to tell us what it was before.
  const wasActive = statusBefore === "ACTIVE";

  // For a Microsoft deployment the agent's address is its M365 mailbox, not the
  // AgentMail inbox — see scripts/migrate-agent-email-to-m365.mjs. Writing the
  // AgentMail address here reverted that migration on every re-provision, so the
  // two now agree on which address is canonical.
  const primaryAgentEmail =
    workspaceProvider === "MICROSOFT" && workspaceEmail ? workspaceEmail : agentEmail;

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      // Re-provisioning a live agent must not send it back through onboarding.
      // AgentMind contributions are gated on ACTIVE, so demoting an
      // already-onboarded deployment silently disables them.
      status: wasActive ? "ACTIVE" : "ONBOARDING",
      onboardingState: wasActive
        ? undefined
        : hasHireAnswers ? "OBSERVATION" : "INTERVIEW",
      containerName,
      agentEmail: primaryAgentEmail,
      agentEmailInboxId: inboxId,
      approvalWebhookToken: config.approvalWebhookToken,
    },
  });

  // 7. Send context to the agent so it knows who it is for subsequent conversations.
  // The formatted introduction email to the manager is sent explicitly by the hiring
  // manager clicking "Send Introduction Email" in the onboarding panel — not auto-sent here.
  const managerEmail = deployment.managerEmail || `admin@${deployment.company.domain}`;
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
            : `You have a SharePoint folder for file storage (Excel trackers, documents). Team members can send you calendar invites at that address.`,
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
