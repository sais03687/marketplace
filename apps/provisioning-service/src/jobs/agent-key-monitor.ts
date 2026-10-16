import path from "node:path";
import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { mintTokenForTenant } from "../clients/microsoft-workspace.js";
import { managementKeyConfigured, openRouterKeys } from "../clients/openrouter-keys.js";
import { AgentKeyStore, type BuyerNotice, type StopAlert } from "../agent-keys.js";

/** The one key store for this process: the broker reads it, deprovision revokes from it. */
export const agentKeys = new AgentKeyStore(
  process.env.AGENT_KEYS_PATH || path.resolve(process.cwd(), ".agent-llm-keys.json"),
  openRouterKeys,
);

const SWEEP_EVERY_MS = 60 * 60 * 1000;

const APP_URL = (process.env.APP_URL || "https://www.agentstore.it.com").replace(/\/+$/, "");

async function sendFromPlatform(to: string, subject: string, lines: string[]): Promise<void> {
  const mailbox = config.platformMailbox;
  if (!mailbox || !config.microsoftTenantId) throw new Error("PLATFORM_MAILBOX or tenant not configured");
  const token = await mintTokenForTenant(config.microsoftTenantId);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: lines.join("\n") },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail ${res.status}`);
}

export type BuyerEmail = BuyerNotice | "safety_stop" | "safety_lifted";

/**
 * Tell the account holder (the hire's manager) about their agent's AI usage.
 * Fixed text only: no model output and no buyer data beyond the agent's name.
 */
export async function notifyBuyer(deploymentId: string, kind: BuyerEmail): Promise<void> {
  const dep = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { agentName: true, managerEmail: true },
  });
  if (!dep?.managerEmail) {
    console.warn(`[agent-key-monitor] no manager email for ${deploymentId}; ${kind} notice not sent`);
    return;
  }
  const name = dep.agentName;
  const dashboard = `${APP_URL}/dashboard`;
  const more =
    "It resets on the 1st of next month. If you need more before then, reply to this email and we will add it.";
  const texts: Record<BuyerEmail, { subject: string; lines: string[] }> = {
    allowance_80: {
      subject: `${name} has used 80% of this month's AI allowance`,
      lines: [
        "Hi,",
        "",
        `${name} has used 80% of the AI usage included in its plan this month.`,
        "It keeps working normally until the allowance is used up.",
        "",
        more,
        "",
        `Your dashboard: ${dashboard}`,
      ],
    },
    allowance_reached: {
      subject: `${name} has used this month's AI allowance`,
      lines: [
        "Hi,",
        "",
        `${name} has used all the AI usage included in its plan this month, so it is not taking on new requests.`,
        "Anyone who emails it gets a short reply saying so. Nothing was sent anywhere else.",
        "",
        more,
        "",
        `Your dashboard: ${dashboard}`,
      ],
    },
    safety_stop: {
      subject: `${name} has been paused for a check`,
      lines: [
        "Hi,",
        "",
        `${name} used AI much faster than normal, so the platform paused it as a precaution while we look into it.`,
        "This is not anything you did, and you have not been charged anything extra.",
        "Anyone who emails it in the meantime gets a short reply saying it is paused.",
        "",
        "We will email you again as soon as it is back.",
      ],
    },
    safety_lifted: {
      subject: `${name} is back`,
      lines: ["Hi,", "", `The check is done and ${name} is working again. You can send it requests as usual.`],
    },
  };
  const t = texts[kind];
  await sendFromPlatform(dep.managerEmail, t.subject, t.lines);
  console.log(`[agent-key-monitor] told the account holder of ${deploymentId}: ${kind}`);
}

/** Email the operator that a hire's safety stop tripped. Called by the broker. */
export async function tellOperator(alert: StopAlert, opts: { test?: boolean } = {}): Promise<void> {
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
        subject: opts.test
          ? `[TEST — nothing was stopped] Safety-stop email check for ${dep?.agentName ?? "an agent"}`
          : `Safety stop: ${dep?.agentName ?? "an agent"} spent $${alert.spentLastHour.toFixed(2)} in under an hour`,
        body: {
          contentType: "Text",
          content: [
            ...(opts.test
              ? ["THIS IS A TEST of the safety-stop email. Nothing was stopped and no key was switched off.", "The figures below are placeholders.", ""]
              : []),
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
