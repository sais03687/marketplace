import path from "node:path";
import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { mintTokenForTenant } from "../clients/microsoft-workspace.js";
import { managementKeyConfigured, openRouterKeys } from "../clients/openrouter-keys.js";
import { AgentKeyStore, type StopAlert } from "../agent-keys.js";

/** The one key store for this process: the broker reads it, deprovision revokes from it. */
export const agentKeys = new AgentKeyStore(
  process.env.AGENT_KEYS_PATH || path.resolve(process.cwd(), ".agent-llm-keys.json"),
  openRouterKeys,
);

const SWEEP_EVERY_MS = 60 * 60 * 1000;

/** Email the operator that a hire's safety stop tripped. Called by the broker. */
export async function tellOperator(alert: StopAlert): Promise<void> {
  const mailbox = config.platformMailbox;
  if (!mailbox || !config.microsoftTenantId) {
    console.error("[agent-key-monitor] cannot email the safety stop — PLATFORM_MAILBOX or tenant not configured");
    return;
  }
  const dep = await prisma.deployment
    .findUnique({ where: { id: alert.deploymentId }, select: { agentName: true, company: { select: { name: true } } } })
    .catch(() => null);
  const who = dep ? `${dep.agentName} (hired by ${dep.company?.name ?? "unknown"})` : alert.deploymentId;
  const token = await mintTokenForTenant(config.microsoftTenantId);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: `Safety stop: ${dep?.agentName ?? "an agent"} spent $${alert.spentLastHour.toFixed(2)} in under an hour`,
        body: {
          contentType: "Text",
          content: [
            `${who} spent $${alert.spentLastHour.toFixed(2)} on AI model calls in under an hour.`,
            `The ${alert.tier} tier's hourly safety stop is $${alert.stop}, so its OpenRouter key has been switched off.`,
            "",
            "The agent cannot call the model until you lift the stop. Its buyer has not been charged anything extra.",
            "Look at what it was doing before lifting it — a loop will spend again.",
            "",
            "To see its spend:  cd /opt/marketplace/apps/provisioning-service && npx tsx scripts/agent-keys-status.mts",
            `To lift the stop:  cd /opt/marketplace/apps/provisioning-service && npx tsx scripts/lift-safety-stop.mts ${alert.deploymentId}`,
          ].join("\n"),
        },
        toRecipients: [{ emailAddress: { address: mailbox } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) console.error(`[agent-key-monitor] safety-stop email failed: ${res.status}`);
}

async function liveHires(ids: string[]): Promise<Set<string>> {
  const rows = await prisma.deployment.findMany({
    where: { id: { in: ids }, status: { not: "FIRED" } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

export function startAgentKeyMonitor(): void {
  if (!managementKeyConfigured()) {
    console.log("[agent-key-monitor] OPENROUTER_MANAGEMENT_KEY not set — per-agent keys off, broker uses the shared key");
    return;
  }
  // The safety stop is not polled here: OpenRouter's per-key usage lags too far
  // to catch a runaway, so the broker meters each call's cost as it returns.
  console.log("[agent-key-monitor] Enabled — broker meters spend per hire; key sweep hourly");
  const sweep = () =>
    agentKeys.sweep(liveHires).catch((err) => console.error("[agent-key-monitor] sweep failed:", err.message));
  setTimeout(sweep, 60 * 1000);
  setInterval(sweep, SWEEP_EVERY_MS);
}
