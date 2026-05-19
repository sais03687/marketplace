// Thin wrapper around AgentMail API for sending notification emails.

interface SendNotificationEmailParams {
  inboxId: string | undefined | null;
  to: string;
  subject: string;
  html: string;
}

/**
 * Fire-and-forget email send via AgentMail API.
 * Gracefully skips if inboxId or API key is missing.
 * Never throws -- catches and logs all errors.
 */
export async function sendNotificationEmail({
  inboxId,
  to,
  subject,
  html,
}: SendNotificationEmailParams): Promise<void> {
  const apiKey = process.env.AGENTMAIL_API_KEY;

  if (!inboxId) {
    console.warn("[email] Skipping send: no inboxId provided");
    return;
  }

  if (!apiKey) {
    console.warn("[email] Skipping send: AGENTMAIL_API_KEY is not set");
    return;
  }

  try {
    const res = await fetch(
      `https://api.agentmail.to/v0/inboxes/${inboxId}/messages/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          to: [to],
          subject,
          html,
        }),
      }
    );

    if (!res.ok) {
      console.error(
        `[email] AgentMail API returned ${res.status}: ${await res.text()}`
      );
    }
  } catch (err) {
    console.error("[email] Failed to send notification email:", err);
  }
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
}

/**
 * Builds the subject and inline-styled HTML body for an approval notification.
 */
export function buildApprovalNotificationEmail({
  agentName,
  taskType,
  draftPreview,
  portalUrl,
}: BuildApprovalNotificationEmailParams): { subject: string; html: string } {
  const subject = `Action needed: ${agentName} needs approval for ${taskType}`;

  const truncatedPreview =
    draftPreview.length > 200
      ? draftPreview.slice(0, 200) + "..."
      : draftPreview;

  const ctaHref = portalUrl || "/dashboard";

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
                ${agentName} needs your approval
              </h1>
              <p style="margin:0 0 8px;font-size:14px;color:#71717a;">
                <strong style="color:#18181b;">Task type:</strong> ${taskType}
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#3f3f46;background-color:#f4f4f5;padding:12px;border-radius:6px;line-height:1.5;">
                ${truncatedPreview}
              </p>
              <a href="${ctaHref}" style="display:inline-block;background-color:#18181b;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:10px 20px;border-radius:6px;">
                Review &amp; Approve
              </a>
              <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">
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
