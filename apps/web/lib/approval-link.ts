import crypto from "node:crypto";

/**
 * Signed one-approval links for the buttons in a notification email.
 *
 * Deliberately not the deployment's portalToken. That token is permanent and
 * scoped to the whole deployment, so every notification email ever sent carries a
 * credential that can act on all of that agent's future approvals — including
 * ones raised long after the email was read. A token derived from the approval id
 * can only ever resolve that single approval, and stops working the moment the
 * approval leaves PENDING.
 *
 * Derived rather than stored, like agent-token.ts: nothing to migrate, nothing to
 * leak from the database, and both halves recompute it from the platform secret.
 */
function secret(): string {
  return process.env.APPROVAL_LINK_SECRET || process.env.PROVISIONING_SECRET || "";
}

export function approvalLinkToken(approvalId: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`approval-link:${approvalId}`)
    .digest("hex");
}

/** Constant-time compare, so a token cannot be discovered a byte at a time. */
export function approvalLinkTokenMatches(presented: string, approvalId: string): boolean {
  if (!secret() || !presented) return false;
  const expected = approvalLinkToken(approvalId);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export type ApprovalDecision = "approve" | "reject";

/**
 * The URL a button points at. This is a *confirmation* page, never the action
 * itself — see the route for why that matters.
 */
export function approvalActionUrl(
  baseUrl: string,
  approvalId: string,
  decision: ApprovalDecision,
): string {
  const t = approvalLinkToken(approvalId);
  return `${baseUrl.replace(/\/$/, "")}/approve/action/${approvalId}/${decision}?t=${t}`;
}
