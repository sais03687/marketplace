/**
 * Lightweight HTTP proxy server that lets the Vercel web app reach agent
 * containers running on this host (which are only reachable via localhost).
 *
 * Endpoints:
 *   GET /proxy/:deploymentId/memory
 *   GET /proxy/:deploymentId/skills
 *   POST /internal/microsoft-token   — mint Graph API token for a deployment
 *   POST /internal/outlook-send      — send email via Microsoft Graph on behalf of agent
 *   POST /internal/teams-install      — install Teams app into buyer org catalog
 *   POST /internal/teams-approval-notify — send proactive approval card to manager in Teams
 *   POST /api/teams/messages          — Bot Framework messaging endpoint (Teams DMs)
 *
 * Secured with a Bearer token (PROVISIONING_SECRET env var).
 * Set PROVISIONING_PORT to override the default port (3003).
 */
import http from "node:http";
import crypto from "node:crypto";
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  TurnContext,
  ActivityTypes,
  CardFactory,
  ConversationParameters,
  TeamsInfo,
} from "botbuilder";
import { ConnectorClient, MicrosoftAppCredentials } from "botframework-connector";
import { prisma } from "@marketplace/db";
import { mintTokenForTenant, installTeamsAppForTenant, getUserByEmail } from "./clients/microsoft-workspace.js";
import { config } from "./config.js";

const SECRET = process.env.PROVISIONING_SECRET || "";
const PORT = parseInt(process.env.PROVISIONING_PORT || "3003", 10);
const BOT_HOSTNAME = process.env.BOT_HOSTNAME || "bot.agentstore.it.com";
const MARKETPLACE_URL = process.env.MARKETPLACE_URL || "https://www.agentstore.it.com";

// ─── Temp file store for serving images/files in Teams messages ───────────
// Files expire after 1 hour. Keyed by random ID.
const _tempFiles = new Map<string, { data: Buffer; contentType: string; expiresAt: number }>();

function storeTempFile(base64: string, contentType: string): string {
  const id = crypto.randomUUID();
  const data = Buffer.from(base64, "base64");
  _tempFiles.set(id, { data, contentType, expiresAt: Date.now() + 3600_000 });
  return id;
}

// Cleanup expired files every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, file] of _tempFiles) {
    if (file.expiresAt < now) _tempFiles.delete(id);
  }
}, 600_000);

// ─── Approval Adaptive Card for Teams ─────────────────────────────────────
function buildApprovalCard(params: {
  agentName: string;
  taskType: string;
  draftPreview: string;
  approvalId: string;
  portalUrl?: string;
}) {
  const { agentName, taskType, draftPreview, approvalId, portalUrl } = params;
  const body: unknown[] = [
    {
      type: "TextBlock",
      text: `🔔 ${agentName} needs your approval`,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    },
    {
      type: "TextBlock",
      text: `Task: ${taskType}`,
      spacing: "Small",
      isSubtle: true,
    },
    {
      type: "TextBlock",
      text: "Draft:",
      weight: "Bolder",
      spacing: "Medium",
    },
    {
      type: "TextBlock",
      text: draftPreview.slice(0, 1000) || "(empty)",
      wrap: true,
      maxLines: 15,
    },
  ];

  if (portalUrl) {
    body.push({
      type: "TextBlock",
      text: `[View in portal](${portalUrl})`,
      spacing: "Small",
      isSubtle: true,
    });
  }

  return CardFactory.adaptiveCard({
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
    actions: [
      {
        type: "Action.Submit",
        title: "✅ Approve",
        style: "positive",
        data: { mktAction: "APPROVED", approvalId },
      },
      {
        type: "Action.Submit",
        title: "❌ Reject",
        style: "destructive",
        data: { mktAction: "REJECTED", approvalId },
      },
      {
        type: "Action.ShowCard",
        title: "✏️ Edit & Approve",
        card: {
          type: "AdaptiveCard",
          body: [
            {
              type: "Input.Text",
              id: "editedText",
              placeholder: "Edit the draft before approving...",
              isMultiline: true,
              value: draftPreview,
            },
          ],
          actions: [
            {
              type: "Action.Submit",
              title: "Submit Edit",
              data: { mktAction: "EDITED", approvalId },
            },
          ],
        },
      },
    ],
  });
}

// ─── Proactive Teams messaging for approvals ──────────────────────────────
async function sendApprovalToManager(params: {
  managerEmail: string;
  tenantId: string;
  serviceUrl: string;
  agentName: string;
  taskType: string;
  draftPreview: string;
  approvalId: string;
  portalToken?: string;
}) {
  const { managerEmail, tenantId, serviceUrl, agentName, taskType, draftPreview, approvalId, portalToken } = params;

  // 1. Resolve manager's Azure AD user ID from email
  const userInfo = await getUserByEmail(managerEmail, tenantId);
  console.log(`[teams-approval] Resolved ${managerEmail} → AAD ID ${userInfo.id}`);

  // 2. Build the Adaptive Card
  const portalUrl = portalToken ? `${MARKETPLACE_URL}/approve/${portalToken}` : undefined;
  const card = buildApprovalCard({ agentName, taskType, draftPreview, approvalId, portalUrl });

  // 3. Send proactive message via Bot Framework
  // Create conversation with the manager and send the card
  const appId = config.microsoftClientId;
  const appPassword = config.microsoftClientSecret;

  const credentials = new MicrosoftAppCredentials(appId, appPassword, tenantId);
  const connectorClient = new ConnectorClient(credentials, { baseUri: serviceUrl });

  // Create a 1:1 conversation between the bot and the manager
  const conversationParams: ConversationParameters = {
    isGroup: false,
    bot: { id: appId, name: "Agent Store" },
    members: [{ id: `29:${userInfo.id}`, name: userInfo.displayName }],
    tenantId,
    channelData: { tenant: { id: tenantId } },
    activity: undefined as unknown as import("botbuilder").Activity,
  };

  const response = await connectorClient.conversations.createConversation(conversationParams);
  const conversationId = response.id;

  // Send the approval card into the new conversation
  await connectorClient.conversations.sendToConversation(conversationId!, {
    type: "message",
    attachments: [card],
    from: { id: appId, name: "Agent Store" },
    recipient: { id: `29:${userInfo.id}`, name: userInfo.displayName },
  } as import("botbuilder").Partial<import("botbuilder").Activity> as any);

  console.log(`[teams-approval] Sent approval card to ${managerEmail} (conversation ${conversationId})`);
  return conversationId;
}

// Bot adapter is created lazily inside startProxyServer() so env vars are loaded first.
let botAdapter: CloudAdapter | null = null;

/** Wrap raw http.IncomingMessage to satisfy botbuilder's Request interface. */
function toBotRequest(req: http.IncomingMessage): Promise<import("botbuilder").Request> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        resolve({
          body: body ? JSON.parse(body) : {},
          headers: req.headers as Record<string, string | string[] | undefined>,
          method: req.method,
        });
      } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

/** Wrap raw http.ServerResponse to satisfy botbuilder's Response interface. */
function toBotResponse(res: http.ServerResponse) {
  return {
    socket: res.socket,
    end(...args: unknown[]) { (res.end as Function)(...args); },
    header(name: string, value: unknown) { res.setHeader(name, value as string); },
    send(bodyOrStatus?: unknown) {
      if (typeof bodyOrStatus === "number") {
        res.statusCode = bodyOrStatus;
        res.end();
      } else if (typeof bodyOrStatus === "string") {
        res.end(bodyOrStatus);
      } else if (bodyOrStatus !== undefined) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(bodyOrStatus));
      } else {
        res.end();
      }
    },
    status(code: number) {
      res.statusCode = code;
      return this; // chainable: res.status(200).send(...)
    },
  };
}

function send(res: http.ServerResponse, status: number, body: object) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

async function proxyContainer(
  deploymentId: string,
  path: string,
  res: http.ServerResponse,
) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { containerName: true, status: true },
  });

  if (!deployment) return send(res, 404, { error: "Deployment not found" });
  if (!deployment.containerName) {
    return send(res, 200, { memory: null, skills: [], message: "Container not running" });
  }

  const containerUrl = deployment.containerName.startsWith("http")
    ? deployment.containerName
    : `http://${deployment.containerName}:4100`;

  try {
    const upstream = await fetch(`${containerUrl}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await upstream.json();
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch {
    send(res, 200, { memory: null, skills: [], message: "Container unreachable" });
  }
}

export function startProxyServer() {
  // ─── Bot Framework adapter (Teams) ────────────────────────────────────────
  // Created here (not at module level) so env vars from pm2 env_file are loaded.
  const botAuth = new ConfigurationBotFrameworkAuthentication({
    MicrosoftAppId: config.microsoftClientId,
    MicrosoftAppPassword: config.microsoftClientSecret,
    MicrosoftAppType: "SingleTenant",
    MicrosoftAppTenantId: config.microsoftTenantId,
  });
  botAdapter = new CloudAdapter(botAuth);
  botAdapter.onTurnError = async (context: TurnContext, error: Error) => {
    console.error("[teams-bot] Unhandled error:", error.message);
    try {
      await context.sendActivity("Sorry, something went wrong processing your message.");
    } catch { /* best-effort */ }
  };

  const server = http.createServer(async (req, res) => {
    // Microsoft Graph change notification webhook — no Bearer auth (Graph uses clientState validation)
    // GET: validation handshake during subscription creation
    if (req.url?.startsWith("/webhooks/microsoft")) {
      // Graph sends validation as POST with validationToken in query string
      const qIndex = req.url.indexOf("?");
      if (qIndex !== -1) {
        const rawQuery = req.url.slice(qIndex + 1);
        const match = rawQuery.match(/(?:^|&)validationToken=([^&]*)/);
        if (match) {
          console.log("[webhook] Graph validation token received, echoing back");
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(decodeURIComponent(match[1].replace(/\+/g, " ")));
          return;
        }
      }
    }
    // POST: incoming change notification (new email arrived at workspace address)
    if (req.method === "POST" && req.url?.startsWith("/webhooks/microsoft")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body) as {
            value?: Array<{ clientState?: string; resourceData?: unknown }>;
          };
          const notifications = payload.value ?? [];
          for (const notification of notifications) {
            const deploymentId = notification.clientState;
            if (!deploymentId) continue;
            const deployment = await prisma.deployment.findUnique({
              where: { id: deploymentId },
              select: { containerName: true },
            });
            if (!deployment?.containerName) continue;
            const containerUrl = deployment.containerName.startsWith("http")
              ? deployment.containerName
              : `http://localhost:${deployment.containerName}`;
            // Forward to agent container's agentmail hook (same pipeline as Agentmail)
            fetch(`${containerUrl}/hooks/agentmail`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source: "microsoft", notification }),
            }).catch(() => {});
          }
          send(res, 202, { accepted: true });
        } catch {
          send(res, 202, { accepted: true }); // always 202 to Graph
        }
      });
      return;
    }

    // Internal token endpoint — agent containers request Graph API tokens here
    // instead of holding Microsoft secrets directly.
    if (req.method === "POST" && req.url === "/internal/microsoft-token") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { deploymentId } = JSON.parse(body) as { deploymentId?: string };
          if (!deploymentId) return send(res, 400, { error: "deploymentId required" });

          const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { id: true, buyerMicrosoftTenantId: true },
          });

          if (!deployment) return send(res, 404, { error: "Deployment not found" });

          const tenantId = deployment.buyerMicrosoftTenantId || config.microsoftTenantId;
          if (!tenantId) {
            return send(res, 404, { error: "No Microsoft tenant configured for this deployment" });
          }

          const tokenData = await mintTokenForTenant(tenantId);
          send(res, 200, tokenData);
        } catch (err: any) {
          console.error("[microsoft-token] Error:", err.message);
          send(res, 500, { error: "Failed to mint token" });
        }
      });
      return;
    }

    // Internal endpoint — agent containers send email via Microsoft Graph
    if (req.method === "POST" && req.url === "/internal/outlook-send") {
      let body = "";
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", async () => {
        try {
          const {
            deploymentId,
            agentEmail,
            to,
            subject,
            body: emailBody,
            bodyType = "html",
            replyToMessageId,
            cc,
            attachments,
          } = JSON.parse(body) as {
            deploymentId?: string;
            agentEmail?: string;
            to?: string | string[];
            subject?: string;
            body?: string;
            bodyType?: "text" | "html";
            replyToMessageId?: string;
            cc?: string[];
            attachments?: Array<{ name: string; content_base64: string; contentType: string }>;
          };

          if (!deploymentId) return send(res, 400, { error: "deploymentId required" });
          if (!agentEmail) return send(res, 400, { error: "agentEmail required" });
          if (!to) return send(res, 400, { error: "to required" });
          if (!emailBody) return send(res, 400, { error: "body required" });

          const deployment = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { id: true, buyerMicrosoftTenantId: true },
          });

          if (!deployment) return send(res, 404, { error: "Deployment not found" });

          // Use buyer tenant if connected, otherwise fall back to platform tenant
          const tenantId = deployment.buyerMicrosoftTenantId || config.microsoftTenantId;
          if (!tenantId) return send(res, 500, { error: "No Microsoft tenant configured" });

          const tokenData = await mintTokenForTenant(tenantId);
          const accessToken = tokenData.access_token;

          // Normalise recipients to array of Graph emailAddress objects
          const toArray = Array.isArray(to) ? to : [to];
          const toRecipients = toArray.map((addr) => ({ emailAddress: { address: addr } }));
          const ccRecipients = (cc ?? []).map((addr) => ({ emailAddress: { address: addr } }));

          const graphBase = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(agentEmail)}`;

          if (replyToMessageId) {
            // Reply to existing message thread
            const replyMessage: Record<string, unknown> = {
              toRecipients,
              ...(ccRecipients.length > 0 ? { ccRecipients } : {}),
              body: { contentType: bodyType, content: emailBody },
            };
            if (attachments && attachments.length > 0) {
              replyMessage.attachments = attachments.map((a) => ({
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: a.name,
                contentType: a.contentType,
                contentBytes: a.content_base64,
              }));
            }
            const replyPayload: Record<string, unknown> = {
              message: replyMessage,
            };

            const replyResp = await fetch(
              `${graphBase}/messages/${encodeURIComponent(replyToMessageId)}/reply`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(replyPayload),
              },
            );

            if (!replyResp.ok) {
              const err = await replyResp.text();
              console.error("[outlook-send] Reply failed:", replyResp.status, err);
              return send(res, 502, { error: `Graph API error: ${replyResp.status}` });
            }
          } else {
            // Send new email
            if (!subject) return send(res, 400, { error: "subject required for new emails" });

            const message: Record<string, unknown> = {
              subject,
              body: { contentType: bodyType, content: emailBody },
              toRecipients,
            };
            if (ccRecipients.length > 0) message.ccRecipients = ccRecipients;
            if (attachments && attachments.length > 0) {
              message.attachments = attachments.map((a) => ({
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: a.name,
                contentType: a.contentType,
                contentBytes: a.content_base64,
              }));
            }

            const sendResp = await fetch(`${graphBase}/sendMail`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ message }),
            });

            if (!sendResp.ok) {
              const err = await sendResp.text();
              console.error("[outlook-send] Send failed:", sendResp.status, err);
              return send(res, 502, { error: `Graph API error: ${sendResp.status}` });
            }
          }

          send(res, 200, { success: true });
        } catch (err: any) {
          console.error("[outlook-send] Error:", err.message);
          send(res, 500, { error: "Failed to send email" });
        }
      });
      return;
    }

    // ─── Teams App Auto-Install ──────────────────────────────────────────────
    // Install the Teams app into a buyer's org catalog via Graph API.
    // Called by the web app after admin consent, or manually for existing deployments.
    if (req.method === "POST" && req.url === "/internal/teams-install") {
      let body = "";
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { tenantId } = JSON.parse(body) as { tenantId?: string };
          if (!tenantId) return send(res, 400, { error: "tenantId required" });
          const result = await installTeamsAppForTenant(tenantId);
          console.log(`[teams-install] Installed Teams app for tenant ${tenantId}: ${result.teamsAppId}`);
          send(res, 200, { success: true, teamsAppId: result.teamsAppId });
        } catch (err: any) {
          console.error("[teams-install] Error:", err.message);
          send(res, 500, { error: err.message });
        }
      });
      return;
    }

    // ─── Teams Approval Notification ──────────────────────────────────────
    // Called by the web app when an approval is created for a Teams-connected
    // deployment. Sends a proactive Adaptive Card DM to the manager.
    if (req.method === "POST" && req.url === "/internal/teams-approval-notify") {
      const authHeader = req.headers["authorization"] ?? "";
      if (SECRET && authHeader !== `Bearer ${SECRET}`) {
        return send(res, 401, { error: "Unauthorized" });
      }
      let body = "";
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", async () => {
        try {
          const {
            managerEmail,
            tenantId,
            serviceUrl,
            agentName,
            taskType,
            draftPreview,
            approvalId,
            portalToken,
          } = JSON.parse(body) as Record<string, string | undefined>;

          if (!managerEmail || !tenantId || !serviceUrl || !approvalId) {
            return send(res, 400, { error: "managerEmail, tenantId, serviceUrl, and approvalId are required" });
          }

          const conversationId = await sendApprovalToManager({
            managerEmail,
            tenantId,
            serviceUrl,
            agentName: agentName || "Agent",
            taskType: taskType || "unknown",
            draftPreview: draftPreview || "",
            approvalId,
            portalToken,
          });

          send(res, 200, { success: true, conversationId });
        } catch (err: any) {
          console.error("[teams-approval-notify] Error:", err.message);
          send(res, 500, { error: err.message });
        }
      });
      return;
    }

    // ─── Teams Bot Framework messaging endpoint ────────────────────────────
    // Azure Bot Service POSTs Activities here. JWT validation is handled by
    // the CloudAdapter so no Bearer token check needed.
    if (req.method === "POST" && req.url === "/api/teams/messages") {
      try {
        const botReq = await toBotRequest(req);
        const botRes = toBotResponse(res);
        await botAdapter!.process(botReq, botRes, async (context: TurnContext) => {
          console.log(`[teams-bot] Activity received: type=${context.activity.type} from=${context.activity.from?.name} text=${(context.activity.text || "").slice(0, 50)}`);

          const tenantId = context.activity.conversation?.tenantId
            || context.activity.channelData?.tenant?.id;

          // Store the Teams service URL for proactive messaging (fire-and-forget)
          if (tenantId && context.activity.serviceUrl) {
            prisma.deployment.updateMany({
              where: { buyerMicrosoftTenantId: tenantId, status: "ACTIVE", teamsServiceUrl: null },
              data: { teamsServiceUrl: context.activity.serviceUrl },
            }).catch(() => {});
          }

          // ── Handle Adaptive Card button clicks (approval actions) ──────────
          if (context.activity.type === ActivityTypes.Message && context.activity.value) {
            const submitData = context.activity.value as {
              mktAction?: string;
              approvalId?: string;
              editedText?: string;
              rejectionReason?: string;
            };

            if (submitData.approvalId && submitData.mktAction) {
              console.log(`[teams-bot] Approval action: ${submitData.mktAction} for ${submitData.approvalId}`);
              try {
                // Look up the approval to find the deployment and portal token
                const approval = await prisma.approval.findUnique({
                  where: { id: submitData.approvalId },
                  include: { deployment: { select: { portalToken: true } } },
                });

                if (!approval) {
                  await context.sendActivity("⚠️ Approval not found.");
                  return;
                }
                if (approval.status !== "PENDING") {
                  await context.sendActivity(`This approval has already been ${approval.status.toLowerCase()}.`);
                  return;
                }

                // Resolve via the portal API endpoint
                const portalToken = approval.deployment.portalToken;
                const resolveResp = await fetch(
                  `${MARKETPLACE_URL}/api/portal/${portalToken}/approvals/${submitData.approvalId}/resolve`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: submitData.mktAction,
                      editedText: submitData.editedText,
                      rejectionReason: submitData.rejectionReason,
                    }),
                  },
                );

                if (resolveResp.ok) {
                  const actionLabel = submitData.mktAction === "APPROVED" ? "✅ Approved"
                    : submitData.mktAction === "EDITED" ? "✅ Approved (with edits)"
                    : "❌ Rejected";
                  await context.sendActivity(`${actionLabel} — the agent has been notified.`);
                } else {
                  const err = await resolveResp.text();
                  console.error("[teams-bot] Approval resolve failed:", resolveResp.status, err);
                  await context.sendActivity("⚠️ Failed to process approval. Please try via the web portal.");
                }
              } catch (err: any) {
                console.error("[teams-bot] Approval handler error:", err.message);
                await context.sendActivity("⚠️ Something went wrong processing the approval.");
              }
              return;
            }
          }

          // Only handle message activities (ignore typing, conversationUpdate, etc.)
          if (context.activity.type !== ActivityTypes.Message) return;

          const text = (context.activity.text || "").trim();
          if (!text) return;

          const teamsUserId = context.activity.from?.id;
          const teamsUserName = context.activity.from?.name || "Teams User";

          console.log(`[teams-bot] tenantId=${tenantId} userId=${teamsUserId} userName=${teamsUserName}`);

          if (!tenantId) {
            await context.sendActivity("Unable to identify your organization. Please contact support.");
            return;
          }

          // Find active deployment(s) for this buyer tenant
          const deployments = await prisma.deployment.findMany({
            where: {
              buyerMicrosoftTenantId: tenantId,
              status: "ACTIVE",
            },
            select: { id: true, containerName: true, agentName: true },
          });

          if (deployments.length === 0) {
            await context.sendActivity(
              "No active agent found for your organization. "
              + "Please ensure an agent has been deployed and your Microsoft 365 tenant is connected."
            );
            return;
          }

          // For MVP: route to the first active deployment for this tenant.
          // TODO: if multiple agents exist, let the user pick via Adaptive Card.
          const deployment = deployments[0];

          if (!deployment.containerName) {
            await context.sendActivity(
              `${deployment.agentName} is currently starting up. Please try again in a moment.`
            );
            return;
          }

          const containerUrl = deployment.containerName.startsWith("http")
            ? deployment.containerName
            : `http://${deployment.containerName}:4100`;

          // Send typing indicator while the agent processes
          await context.sendActivity({ type: ActivityTypes.Typing });

          // Keep sending typing every 3s (Teams typing indicator lasts ~3s)
          const typingInterval = setInterval(async () => {
            try {
              await context.sendActivity({ type: ActivityTypes.Typing });
            } catch { /* conversation may have ended */ }
          }, 3000);

          try {
            // Forward to agent container's /hooks/teams endpoint
            const hookResponse = await fetch(`${containerUrl}/hooks/teams`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message: text,
                teamsUserId,
                teamsUserName,
                tenantId,
                deploymentId: deployment.id,
                conversationId: context.activity.conversation?.id,
              }),
              signal: AbortSignal.timeout(180_000), // 180s — complex analysis needs multiple LLM + python iterations
            });

            const result = await hookResponse.json() as {
              ok?: boolean;
              reply?: string;
              error?: string;
              files?: Array<{ name: string; base64: string; contentType: string }>;
            };

            clearInterval(typingInterval);

            if (result.ok && result.reply) {
              // Check if there are image files to send as Adaptive Card
              const imageFiles = (result.files || []).filter(
                (f) => f.contentType?.startsWith("image/"),
              );

              if (imageFiles.length > 0) {
                // Store images and build URLs
                const imageUrls = imageFiles.map((f) => {
                  const fileId = storeTempFile(f.base64, f.contentType);
                  return `https://${BOT_HOSTNAME}/api/files/${fileId}`;
                });

                // Build Adaptive Card with text + images
                const cardBody: unknown[] = [
                  {
                    type: "TextBlock",
                    text: result.reply,
                    wrap: true,
                    size: "Default",
                  },
                ];
                for (const url of imageUrls) {
                  cardBody.push({
                    type: "Image",
                    url,
                    size: "Large",
                    altText: "Chart",
                  });
                }

                const card = CardFactory.adaptiveCard({
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.4",
                  body: cardBody,
                });
                await context.sendActivity({ attachments: [card] });
              } else {
                await context.sendActivity(result.reply);
              }

              // Send any non-image file attachments (Excel, CSV, etc.)
              const otherFiles = (result.files || []).filter(
                (f) => !f.contentType?.startsWith("image/"),
              );
              for (const f of otherFiles) {
                const fileId = storeTempFile(f.base64, f.contentType);
                const fileUrl = `https://${BOT_HOSTNAME}/api/files/${fileId}`;
                await context.sendActivity(
                  `📎 [${f.name}](${fileUrl})`,
                );
              }
            } else {
              await context.sendActivity(
                result.error || "I wasn't able to process your message. Please try again."
              );
            }
          } catch (err: any) {
            clearInterval(typingInterval);
            console.error("[teams-bot] Container call failed:", err.message);
            await context.sendActivity(
              "The agent took too long to respond. Please try again with a simpler request."
            );
          }
        });
      } catch (err: any) {
        console.error("[teams-bot] Adapter error:", err.message);
        if (!res.headersSent) {
          send(res, 500, { error: "Bot Framework error" });
        }
      }
      return;
    }

    // ─── Temp file serving (for Teams inline images) ─────────────────────────
    const fileMatch = req.url?.match(/^\/api\/files\/([a-f0-9-]+)$/);
    if (req.method === "GET" && fileMatch) {
      const file = _tempFiles.get(fileMatch[1]!);
      if (!file) return send(res, 404, { error: "File not found or expired" });
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": file.data.length,
        "Cache-Control": "public, max-age=3600",
      });
      res.end(file.data);
      return;
    }

    // Auth for proxy endpoints
    const auth = req.headers["authorization"] ?? "";
    if (SECRET && auth !== `Bearer ${SECRET}`) {
      return send(res, 401, { error: "Unauthorized" });
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true });
    }

    // Route: /proxy/:deploymentId/memory or /proxy/:deploymentId/skills
    const match = req.url?.match(/^\/proxy\/([^/]+)\/(memory|skills)$/);
    if (!match || req.method !== "GET") {
      return send(res, 404, { error: "Not found" });
    }

    const [, deploymentId, endpoint] = match;
    try {
      await proxyContainer(deploymentId, `/internal/${endpoint}`, res);
    } catch (err: any) {
      send(res, 500, { error: err.message });
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[proxy-server] Listening on port ${PORT}`);
  });

  return server;
}
