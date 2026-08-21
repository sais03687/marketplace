import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { mintTokenForTenant } from "../clients/microsoft-workspace.js";

/**
 * Tell the buyer when their agent goes quiet.
 *
 * The agent posts a heartbeat every 60s. If an ACTIVE deployment stops posting,
 * something is wrong — the container died, the process hung, the host lost the
 * network — and nothing else would say so; the buyer would discover it through
 * days of silence. This runs on the VPS rather than as a Vercel cron because
 * Vercel Hobby caps crons at one a day, far too coarse for a liveness check.
 *
 * Alerts once per outage. `heartbeatAlertedAt` is set when the mail goes out and
 * cleared by the next heartbeat (in the heartbeat route), so a recovered agent
 * re-arms the alarm and a still-dead one is not re-nagged every cycle.
 */

// A deployment must be quiet this long before it counts as down — several missed
// beats, not one late one.
const STALE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

async function sendAlert(to: string, agentName: string, lastSeen: Date | null): Promise<boolean> {
  const from = config.platformMailbox;
  if (!from || !config.microsoftTenantId) {
    console.error("[heartbeat-monitor] cannot alert — PLATFORM_MAILBOX or tenant not configured");
    return false;
  }
  const seen = lastSeen ? `${Math.round((Date.now() - lastSeen.getTime()) / 60000)} minutes ago` : "some time ago";
  try {
    const token = await mintTokenForTenant(config.microsoftTenantId);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: `Your agent "${agentName}" has stopped responding`,
            body: {
              contentType: "Text",
              content: [
                "Hi,",
                "",
                `Your AI employee "${agentName}" last checked in ${seen} and has ` +
                  "not responded since. It may be down.",
                "",
                "Nothing you asked it to do has been lost — anything in progress is " +
                  "held — but it will not pick up new work until it recovers. This " +
                  "often clears on its own within a few minutes.",
                "",
                "If it stays down, reply to this email and we will look into it.",
              ].join("\n"),
            },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: false,
        }),
      },
    );
    if (!res.ok) {
      console.error(`[heartbeat-monitor] alert send failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error(`[heartbeat-monitor] alert send error: ${err.message}`);
    return false;
  }
}

async function checkOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS);
  // ACTIVE, has checked in at least once (so we know it was alive), gone quiet
  // since the cutoff, and not already alerted for this outage.
  const stale = await prisma.deployment.findMany({
    where: {
      status: "ACTIVE",
      lastHeartbeatAt: { not: null, lt: cutoff },
      heartbeatAlertedAt: null,
    },
    select: { id: true, agentName: true, managerEmail: true, lastHeartbeatAt: true },
  });

  for (const d of stale) {
    if (!d.managerEmail) continue;
    console.warn(`[heartbeat-monitor] ${d.agentName} (${d.id}) is stale — alerting ${d.managerEmail}`);
    const sent = await sendAlert(d.managerEmail, d.agentName, d.lastHeartbeatAt);
    if (sent) {
      // Mark alerted even on a partial failure path would double-nag; only mark
      // when the mail actually went, so a transient send failure retries.
      await prisma.deployment.update({
        where: { id: d.id },
        data: { heartbeatAlertedAt: new Date() },
      });
    }
  }
}

export function startHeartbeatMonitor(): void {
  console.log("[heartbeat-monitor] Enabled — checking agent liveness every 2 min");
  setInterval(() => {
    checkOnce().catch((err) => console.error("[heartbeat-monitor] check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
