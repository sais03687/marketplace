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
        `<li style="margin:0 0 6px;"><strong>${c.name}</strong> — ${c.description}</li>`
    )
    .join("\n");

  const html = emailShell(`
    <p style="margin:0 0 16px;">${greeting}</p>
    <p style="margin:0 0 16px;">I'm ${agentName}, your new AI employee. I've been set up and I'm ready to start working with you and your team.</p>
    ${
      capabilities.length > 0
        ? `<p style="margin:0 0 8px;">Here's what I can help with:</p>
    <ul style="margin:0 0 16px;padding-left:20px;">${capList}</ul>`
        : ""
    }
    <p style="margin:0 0 16px;">You can reach me anytime by emailing <a href="mailto:${agentEmail}" style="color:#1d4ed8;">${agentEmail}</a>. Just send me a task, question, or request and I'll get to work.</p>
    <p style="margin:0 0 16px;">For anything that seems risky or ambiguous, I'll ask for your approval before proceeding. Over time, as we build trust, I'll handle more on my own.</p>
    ${googleServiceAccountEmail ? `<p style="margin:0 0 16px;">Google Workspace: my service account address is ${googleServiceAccountEmail}. Share any Google Drive files, Sheets, or Docs with that address and I'll be able to read and edit them directly.</p>` : ""}
    <p style="margin:0 0 16px;">What would you like me to focus on first?</p>
    <p style="margin:0;color:#71717a;font-size:13px;">Sent by the Marketplace platform on behalf of ${agentName}.</p>
  `);

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
  // No leading glyph. A subject that opens with ✓ or ✗ reads as bulk mail to a
  // filter, and this domain has no reputation to spare.
  const subject = approved
    ? `Approved: ${agentName} v${version} is now live`
    : `Changes needed: ${agentName} v${version}`;

  const bodyText = approved
    ? `Your agent <strong>${agentName}</strong> v${version} has been reviewed and approved. It is now live on the Marketplace and available for buyers to hire.`
    : `Your agent <strong>${agentName}</strong> v${version} was reviewed but did not pass. Please review the feedback below, make the necessary changes, and re-upload a new version.`;

  const feedbackBlock = feedback
    ? `<p style="margin:0 0 16px;padding-left:12px;border-left:2px solid #d4d4d8;color:#3f3f46;">
         <strong>Reviewer feedback:</strong> ${feedback}
       </p>`
    : "";

  const html = emailShell(`
    <p style="margin:0 0 16px;">${bodyText}</p>
    ${feedbackBlock}
    ${!approved ? `<p style="margin:0 0 16px;">Once you have made your changes, go to Creator → Versions and upload a new version with a bumped version number.</p>` : ""}
    <p style="margin:0 0 16px;"><a href="${creatorDashboardUrl}" style="color:#1d4ed8;">Open the creator dashboard</a></p>
    <p style="margin:0;color:#71717a;font-size:13px;">Agent: ${agentName} &middot; Version: ${version}</p>
  `);

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
 * The frame every platform email shares.
 *
 * Deliberately dull. These used to be campaign-shaped — a grey canvas, a white
 * card, a coloured header band, pill buttons — which is the look of bulk mail,
 * and on 2026-09-20 Gmail started rejecting this domain outright with 5.7.1
 * "likely unsolicited mail". A new sending domain has no reputation to spend on
 * looking designed. This is a letter: one column, ordinary text, ordinary links.
 *
 * It does not on its own fix deliverability — authentication and sending
 * history do that — but it stops the mail arguing for its own rejection.
 */
function emailShell(inner: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:16px;background-color:#ffffff;">
  <div style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;">
${inner}
  </div>
</body>
</html>`.trim();
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

  // The buyer is being asked to approve this, so they have to be able to read
  // it. At 200 characters the preview stopped inside the agent's opening
  // sentence — before any figure, any file name, any caveat — which asks someone
  // to consent to something they have not been shown. 2,000 is enough for a
  // normal agent reply to arrive whole, and a genuinely long one is cut at a
  // line break with the remainder named rather than silently dropped.
  const LIMIT = 2000;
  let preview = draftPreview;
  let trimmedNote = "";
  if (draftPreview.length > LIMIT) {
    const cut = draftPreview.slice(0, LIMIT);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
    preview = lastBreak > LIMIT / 2 ? cut.slice(0, lastBreak + 1) : cut;
    const remaining = draftPreview.length - preview.length;
    trimmedNote = `\n\n[${remaining} more characters — open it to read the rest before approving]`;
  }
  const truncatedPreview = escapeHtml(preview + trimmedNote).replace(/\n/g, "<br>");
  const safeAgentName = escapeHtml(agentName);
  const safeTaskType = escapeHtml(taskType);

  const ctaHref = portalUrl || "/dashboard";

  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:#1d4ed8;">${label}</a>`;

  // Falls back to the portal link alone when no signed links were supplied, so a
  // caller that has not been updated still produces a usable email.
  const actions = approveUrl && rejectUrl
    ? `${link(approveUrl, "Approve")} &nbsp;·&nbsp; ${link(rejectUrl, "Reject")} &nbsp;·&nbsp; ${link(ctaHref, "Edit it first")}`
    : link(ctaHref, "Review and approve");

  const html = emailShell(`
    <p style="margin:0 0 12px;">${safeAgentName} needs your approval before it goes ahead.</p>
    <p style="margin:0 0 12px;color:#52525b;">Task: ${safeTaskType}</p>
    <p style="margin:0 0 16px;padding-left:12px;border-left:2px solid #d4d4d8;color:#3f3f46;">${truncatedPreview}</p>
    <p style="margin:0 0 16px;">${actions}</p>
    <p style="margin:0 0 8px;color:#52525b;font-size:13px;">Use the links above — replying to this email will not approve anything.</p>
    <p style="margin:0;color:#71717a;font-size:13px;">You are receiving this because an agent you hired needs your approval to proceed.</p>
  `);

  return { subject, html };
}
