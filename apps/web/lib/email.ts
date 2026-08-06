// Outbound notification email.
//
// These used to go exclusively through AgentMail, addressed from a per-deployment
// AgentMail inbox. When agents moved to Microsoft 365, provisioning stopped
// creating those inboxes, so agentEmailInboxId became null on every deployment —
// and the AgentMail helper skips silently when it has no inbox. The result was
// that no buyer had received an approval notification since the migration, while
// the documentation told them approvals arrive by email and no dashboard is
// needed. It failed quietly, in a console.warn nobody reads.
//
// Deployment-scoped notifications now send from the agent's own Microsoft mailbox
// instead. That needs no extra mailbox or licence, it reads correctly to the buyer
// (the agent is the one asking), and a reply lands in the agent's mailbox — which
// the poller already watches, so replying to approve works as documented.

interface SendNotificationEmailParams {
  /** Preferred: send as this deployment's agent over Graph. */
  deploymentId?: string | null;
  agentEmail?: string | null;
  /** Legacy AgentMail path, still used where there is no agent to send as. */
  inboxId?: string | undefined | null;
  to: string;
  subject: string;
  html: string;
}

function provisioningBase(): string {
  return (
    process.env.PROVISIONING_SERVICE_URL ||
    process.env.PROVISIONING_URL ||
    "https://api.agentstore.it.com"
  );
}

/**
 * Send as the platform itself, for mail with no agent behind it.
 *
 * Creator vetting decisions are the case that matters: a creator has no
 * deployment and no agent mailbox, so the deployment-scoped path below cannot
 * carry them. Until this existed the only other route was AgentMail, retired —
 * and gated behind PLATFORM_NOTIFICATION_INBOX_ID, which is referenced exactly
 * once in the codebase and set nowhere, so approvals and rejections were never
 * sent and never logged. A creator could be rejected and simply never told.
 *
 * Throws rather than returning false: callers here are telling someone the
 * outcome of their submission, and that failing silently is the bug being fixed.
 */
export async function sendPlatformEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const secret = process.env.PROVISIONING_SECRET;
  if (!secret) throw new Error("PROVISIONING_SECRET is not set");

  const res = await fetch(`${provisioningBase().replace(/\/$/, "")}/internal/platform-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ to: params.to, subject: params.subject, body: params.html, bodyType: "html" }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`platform-send returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Send as the agent, via the provisioning service's Graph-backed send endpoint.
 * Returns true when accepted, so the caller can decide whether to fall back.
 */
async function sendAsAgent(
  deploymentId: string,
  agentEmail: string,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  const secret = process.env.PROVISIONING_SECRET;
  if (!secret) {
    console.warn("[email] No PROVISIONING_SECRET — cannot send as the agent");
    return false;
  }
  try {
    const res = await fetch(`${provisioningBase().replace(/\/$/, "")}/internal/outlook-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ deploymentId, agentEmail, to, subject, body: html, bodyType: "html" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    console.error(`[email] outlook-send returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return false;
  } catch (err: any) {
    console.error(`[email] outlook-send failed: ${err.message}`);
    return false;
  }
}

/**
 * Fire-and-forget notification email. Never throws.
 *
 * Prefers the agent's Microsoft mailbox when the caller supplies a deployment,
 * and falls back to AgentMail for callers that have no agent to send as — creator
 * vetting decisions, for instance.
 */
export async function sendNotificationEmail(params: SendNotificationEmailParams): Promise<void> {
  const { deploymentId, agentEmail, to, subject, html } = params;

  if (deploymentId && agentEmail) {
    if (await sendAsAgent(deploymentId, agentEmail, to, subject, html)) return;
    console.error(
      `[email] Agent send failed for deployment ${deploymentId} — no fallback transport remains`,
    );
  }

  return sendViaAgentMail(params);
}

/**
 * Terminal failure path for a notification with no agent mailbox behind it.
 *
 * This used to POST to AgentMail. Nothing reaches that service any more: every
 * deployment is workspaceProvider MICROSOFT, provisioning no longer creates an
 * @agentmail.to inbox, and the only row that ever held an inbox id is fired. The
 * call could not have succeeded — it was reachable only when `inboxId` was set,
 * and no live deployment has one.
 *
 * Deliberately an error, not a warning. This branch quietly swallowed every
 * approval notification on every Microsoft deployment, and a console.warn on a
 * serverless platform is indistinguishable from nothing happening. If a
 * notification cannot be delivered, that is a failure of the product's core
 * promise and should read like one in the logs.
 */
async function sendViaAgentMail({
  to,
  subject,
}: SendNotificationEmailParams): Promise<void> {
  console.error(
    `[email] NOT SENT to ${to} — no agent mailbox was available to send from. ` +
      `Subject: "${subject}". The recipient will never learn about this.`,
  );
}

// ---------------------------------------------------------------------------
// Introduction email — sent by the PLATFORM, not the agent
// ---------------------------------------------------------------------------

interface BuildIntroductionEmailParams {
  agentName: string;
  agentEmail: string;
  capabilities: Array<{ name: string; description: string }>;
  buyerName?: string;
  googleServiceAccountEmail?: string;
}

/**
 * Builds the intro email that the platform sends on behalf of the agent.
 * This runs at the INTRODUCTION onboarding stage and is enforced regardless
 * of agent architecture (OpenClaw, custom LangChain, etc.).
 */
export function buildIntroductionEmail({
  agentName,
  agentEmail,
  capabilities,
  buyerName,
  googleServiceAccountEmail,
}: BuildIntroductionEmailParams): { subject: string; html: string } {
  const subject = `Meet your new AI employee: ${agentName}`;

  const greeting = buyerName ? `Hi ${buyerName},` : "Hi there,";

  const capList = capabilities
    .slice(0, 6)
    .map(
      (c) =>
        `<li style="margin:0 0 8px;font-size:14px;color:#3f3f46;"><strong style="color:#18181b;">${c.name}</strong> — ${c.description}</li>`
    )
    .join("\n");

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;padding:32px;border:1px solid #e4e4e7;">
          <tr>
            <td>
              <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#18181b;">
                ${greeting}
              </h1>
              <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.6;">
                I'm <strong>${agentName}</strong>, your new AI employee. I've been set up and I'm ready to start working with you and your team.
              </p>
              ${
                capabilities.length > 0
                  ? `<p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#18181b;">Here's what I can help with:</p>
              <ul style="margin:0 0 16px;padding-left:20px;">${capList}</ul>`
                  : ""
              }
              <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.6;">
                You can reach me anytime by emailing
                <a href="mailto:${agentEmail}" style="color:#2563eb;text-decoration:none;font-weight:500;">${agentEmail}</a>.
                Just send me a task, question, or request and I'll get to work.
              </p>
              <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.6;">
                For anything that seems risky or ambiguous, I'll ask for your approval before proceeding. Over time, as we build trust, I'll handle more on my own.
              </p>
              ${googleServiceAccountEmail ? `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.6;">
                <strong style="color:#18181b;">Google Workspace:</strong> My service account address is
                <code style="background:#f4f4f5;padding:2px 5px;border-radius:4px;font-size:13px;">${googleServiceAccountEmail}</code>.
                Share any Google Drive files, Sheets, or Docs with that address and I'll be able to read and edit them directly.
              </p>` : ""}
              <p style="margin:0 0 0;font-size:14px;color:#3f3f46;line-height:1.6;">
                What would you like me to focus on first?
              </p>
              <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">
                This message was sent by the Marketplace platform on behalf of ${agentName}.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// Vetting decision email — sent to creator when admin approves or rejects
// ---------------------------------------------------------------------------

interface BuildVettingDecisionEmailParams {
  agentName: string;
  version: string;
  decision: "MANUALLY_APPROVED" | "FAILED" | "PASSED";
  feedback?: string;
  creatorDashboardUrl?: string;
}

export function buildVettingDecisionEmail({
  agentName,
  version,
  decision,
  feedback,
  creatorDashboardUrl = "https://marketplace.agentmind.to/creator",
}: BuildVettingDecisionEmailParams): { subject: string; html: string } {
  const approved = decision === "MANUALLY_APPROVED" || decision === "PASSED";
  const subject = approved
    ? `✓ Approved: ${agentName} v${version} is now live`
    : `✗ Rejected: ${agentName} v${version} needs changes`;

  const headerColor = approved ? "#16a34a" : "#dc2626";
  const headerText = approved ? "Package approved" : "Package rejected";
  const bodyText = approved
    ? `Your agent <strong>${agentName}</strong> v${version} has been reviewed and approved. It is now live on the Marketplace and available for buyers to hire.`
    : `Your agent <strong>${agentName}</strong> v${version} was reviewed but did not pass. Please review the feedback below, make the necessary changes, and re-upload a new version.`;

  const feedbackBlock = feedback
    ? `<div style="margin:16px 0;background-color:#f4f4f5;border-left:3px solid ${headerColor};padding:12px 16px;border-radius:0 6px 6px 0;">
        <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:0.05em;">Reviewer feedback</p>
        <p style="margin:0;font-size:14px;color:#3f3f46;line-height:1.6;">${feedback}</p>
       </div>`
    : "";

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden;">
          <tr>
            <td style="background-color:${headerColor};padding:16px 32px;">
              <p style="margin:0;font-size:14px;font-weight:600;color:#ffffff;">${headerText}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px;">
              <p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.6;">${bodyText}</p>
              ${feedbackBlock}
              ${!approved ? `<p style="margin:16px 0;font-size:14px;color:#3f3f46;line-height:1.6;">Once you have made your changes, go to <strong>Creator → Versions</strong> and upload a new version with a bumped version number.</p>` : ""}
              <a href="${creatorDashboardUrl}" style="display:inline-block;margin-top:8px;background-color:#18181b;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:10px 20px;border-radius:6px;">
                Go to Creator Dashboard
              </a>
              <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">
                Agent: ${agentName} &middot; Version: ${version}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  return { subject, html };
}

// ---------------------------------------------------------------------------
// Approval notification email template
// ---------------------------------------------------------------------------

interface BuildApprovalNotificationEmailParams {
  agentName: string;
  taskType: string;
  draftPreview: string;
  portalUrl?: string | null;
  /** Confirmation-page links for the Approve and Reject buttons. */
  approveUrl?: string | null;
  rejectUrl?: string | null;
}

/**
 * Everything interpolated below is attacker-influenced: the draft is model
 * output, and the agent name is set by the buyer. Unescaped, a draft containing
 * markup would be rendered as markup in the buyer's mail client.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds the subject and inline-styled HTML body for an approval notification.
 *
 * Carries Approve and Reject buttons rather than asking the buyer to reply. A
 * button sends the decision as data, so there is no natural language to
 * interpret and no way to mistake "sure, but change the date" for consent. Both
 * point at a confirmation page rather than acting directly — mail scanners fetch
 * links to check them, and a link that resolved on GET would be clicked by the
 * scanner before the buyer saw it.
 */
export function buildApprovalNotificationEmail({
  agentName,
  taskType,
  draftPreview,
  portalUrl,
  approveUrl,
  rejectUrl,
}: BuildApprovalNotificationEmailParams): { subject: string; html: string } {
  // The subject prefix is load-bearing: the poller matches on it to answer
  // anyone who replies instead of using the buttons. Keep them in step.
  const subject = `Action needed: ${agentName} needs approval for ${taskType}`;

  const truncatedPreview = escapeHtml(
    draftPreview.length > 200 ? draftPreview.slice(0, 200) + "..." : draftPreview,
  );
  const safeAgentName = escapeHtml(agentName);
  const safeTaskType = escapeHtml(taskType);

  const ctaHref = portalUrl || "/dashboard";

  const button = (href: string, label: string, background: string) =>
    `<a href="${escapeHtml(href)}" style="display:inline-block;background-color:${background};color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:10px 20px;border-radius:6px;margin:0 8px 8px 0;">${label}</a>`;

  // Falls back to the portal link alone when no signed links were supplied, so a
  // caller that has not been updated still produces a usable email.
  const actions = approveUrl && rejectUrl
    ? button(approveUrl, "Approve", "#15803d") +
      button(rejectUrl, "Reject", "#b91c1c") +
      button(ctaHref, "Edit", "#52525b")
    : button(ctaHref, "Review &amp; Approve", "#18181b");

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;padding:32px;border:1px solid #e4e4e7;">
          <tr>
            <td>
              <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#18181b;">
                ${safeAgentName} needs your approval
              </h1>
              <p style="margin:0 0 8px;font-size:14px;color:#71717a;">
                <strong style="color:#18181b;">Task type:</strong> ${safeTaskType}
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#3f3f46;background-color:#f4f4f5;padding:12px;border-radius:6px;line-height:1.5;">
                ${truncatedPreview}
              </p>
              ${actions}
              <p style="margin:16px 0 0;font-size:12px;color:#a1a1aa;">
                Use the buttons above — replying to this email will not approve anything.
              </p>
              <p style="margin:12px 0 0;font-size:12px;color:#a1a1aa;">
                You are receiving this because an agent you hired requires approval to proceed. If you did not expect this, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  return { subject, html };
}
