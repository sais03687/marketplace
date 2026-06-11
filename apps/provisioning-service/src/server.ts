/**
 * Lightweight HTTP proxy server that lets the Vercel web app reach agent
 * containers running on this host (which are only reachable via localhost).
 *
 * Endpoints:
 *   GET /proxy/:deploymentId/memory
 *   GET /proxy/:deploymentId/skills
 *   POST /internal/microsoft-token   — mint Graph API token for a deployment
 *   POST /internal/outlook-send      — send email via Microsoft Graph on behalf of agent
 *
 * Secured with a Bearer token (PROVISIONING_SECRET env var).
 * Set PROVISIONING_PORT to override the default port (3003).
 */
import http from "node:http";
import { prisma } from "@marketplace/db";
import { mintTokenForTenant } from "./clients/microsoft-workspace.js";
import { config } from "./config.js";

const SECRET = process.env.PROVISIONING_SECRET || "";
const PORT = parseInt(process.env.PROVISIONING_PORT || "3003", 10);

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
            const replyPayload: Record<string, unknown> = {
              message: {
                toRecipients,
                ...(ccRecipients.length > 0 ? { ccRecipients } : {}),
                body: { contentType: bodyType, content: emailBody },
              },
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
