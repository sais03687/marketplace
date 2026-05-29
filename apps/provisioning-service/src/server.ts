/**
 * Lightweight HTTP proxy server that lets the Vercel web app reach agent
 * containers running on this host (which are only reachable via localhost).
 *
 * Endpoints:
 *   GET /proxy/:deploymentId/memory
 *   GET /proxy/:deploymentId/skills
 *
 * Secured with a Bearer token (PROVISIONING_SECRET env var).
 * Set PROVISIONING_PORT to override the default port (3003).
 */
import http from "node:http";
import { prisma } from "@marketplace/db";

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
