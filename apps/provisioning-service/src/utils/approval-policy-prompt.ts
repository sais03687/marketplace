/**
 * Renders the hired manager's configured approval policy into a markdown
 * section that gets appended to the agent's AGENTS.md at container startup.
 *
 * This is the OpenClaw equivalent of adapter.py's _should_require_approval():
 * because OpenClaw's email tools can't be intercepted deterministically,
 * we instead translate the same autonomyConfig into a prompt block that the
 * LLM is instructed to follow at every session.
 *
 * For CUSTOM runtime, adapter.py still provides deterministic enforcement.
 * For OPENCLAW runtime, this prompt block is the policy layer. Both runtimes
 * share the same source of truth: deployment.autonomyConfig + onboarding
 * answers.
 */

export interface AutonomyConfig {
  approvalPolicy?: string;
  approvalRiskThreshold?: number | string;
  autoApproveList?: string[] | string;
  requireApprovalList?: string[] | string;
  [key: string]: unknown;
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(/[\n,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function renderList(label: string, items: string[], note: string): string {
  if (items.length === 0) return "";
  const lines = items.map((i) => `- ${i}`).join("\n");
  return `\n### ${label}\n${note}\n\n${lines}\n`;
}

export function buildApprovalPolicySection(
  autonomyConfig: AutonomyConfig | null | undefined,
  companyDomain: string,
): string {
  const ac = autonomyConfig ?? {};
  const policy =
    typeof ac.approvalPolicy === "string"
      ? ac.approvalPolicy.trim().toLowerCase()
      : "external-only";
  const threshold =
    typeof ac.approvalRiskThreshold === "number"
      ? ac.approvalRiskThreshold
      : typeof ac.approvalRiskThreshold === "string"
        ? parseFloat(ac.approvalRiskThreshold) || 6.0
        : 6.0;
  const autoApprove = toList(ac.autoApproveList);
  const requireApproval = toList(ac.requireApprovalList);

  const domain = (companyDomain || "").trim();
  const domainClause = domain ? `@${domain}` : "your company domain";

  let intro: string;
  switch (policy) {
    case "always":
      intro = [
        "## Your Approval Policy: ALWAYS ASK",
        "",
        "Your hiring manager has configured the strictest policy: **every outbound email requires explicit approval before sending**, regardless of recipient or risk score.",
        "",
        "**Before calling `email_reply` or `email_send` for ANY message:**",
        "",
        "1. Call `queue_approval` with the draft, reasoning, and a risk score. Save the returned approval ID.",
        "2. Call `email_reply` to present the draft to the hiring manager in the current thread (they will receive it via their notification email). Format:",
        "   ```",
        "   I'd like to send the following email:",
        "",
        "   To: [recipient]",
        "   Subject: [subject]",
        "",
        "   [draft body]",
        "",
        "   Reply APPROVE to send, EDIT with changes, or REJECT to cancel.",
        "   ```",
        "3. **Wait** for the manager's reply. Do not send the real email until you see APPROVE/EDIT/REJECT.",
        "4. On APPROVE: call `resolve_approval(id, \"approved\")` then send the real email.",
        "5. On EDIT: apply the edits, call `resolve_approval(id, \"edited\")`, then send.",
        "6. On REJECT: call `resolve_approval(id, \"rejected\")` and do not send.",
      ].join("\n");
      break;

    case "risk-based":
      intro = [
        "## Your Approval Policy: RISK-BASED",
        "",
        `Your hiring manager has configured a risk-based policy with threshold **${threshold.toFixed(1)}**.`,
        "",
        "Before every outbound action, score it on three axes (each 0-10):",
        "",
        "| Axis | Question | Scale |",
        "|------|----------|-------|",
        "| **Stakes** | How impactful is this action? | 0 = read-only, 5 = creates/modifies, 10 = sends externally or deletes |",
        "| **Ambiguity** | How clear are the parameters? | 0 = fully specified, 5 = some gaps, 10 = missing critical info |",
        "| **Reversibility** | Can this be undone? | 0 = trivially undoable, 5 = partially, 10 = irreversible |",
        "",
        "**Combined score = (Stakes × 0.5) + (Ambiguity × 0.3) + (Reversibility × 0.2)**",
        "",
        `- If combined score **≥ ${threshold.toFixed(1)}** → **queue approval** via \`queue_approval\` + \`email_reply\` (present draft, wait for APPROVE/EDIT/REJECT).`,
        "- If combined score **< " + threshold.toFixed(1) + "** → proceed directly via `email_reply` / `email_send`.",
      ].join("\n");
      break;

    case "never":
      intro = [
        "## Your Approval Policy: NEVER ASK (Fully Autonomous)",
        "",
        "Your hiring manager has configured a fully-autonomous policy: **send emails directly without queuing approvals**. Use judgment — if you are less than 70% confident about an action, still stop and ask.",
        "",
        "Call `email_reply` or `email_send` directly. Do NOT call `queue_approval` unless the recipient is on the override list below.",
      ].join("\n");
      break;

    case "external-only":
    default:
      intro = [
        "## Your Approval Policy: EXTERNAL-ONLY (Default)",
        "",
        `Your hiring manager has configured the default policy: **emails to external recipients require approval; internal messages auto-send**.`,
        "",
        `- **Internal** = recipients ending in \`${domainClause}\` or on the always-auto-approve list below.`,
        "- **External** = everyone else.",
        "",
        "**For external recipients:**",
        "1. Call `queue_approval` with the draft, reasoning, and risk score. Save the approval ID.",
        "2. Call `email_reply` to present the draft to the hiring manager in the current thread. Format:",
        "   ```",
        "   I'd like to send the following email:",
        "",
        "   To: [recipient]",
        "   Subject: [subject]",
        "",
        "   [draft body]",
        "",
        "   Reply APPROVE to send, EDIT with changes, or REJECT to cancel.",
        "   ```",
        "3. Wait for the manager's reply. Do not send the real email until you see APPROVE/EDIT/REJECT.",
        "4. On APPROVE: call `resolve_approval(id, \"approved\")` then send the real email.",
        "5. On REJECT: call `resolve_approval(id, \"rejected\")` and do not send.",
        "",
        "**For internal recipients:** call `email_reply` or `email_send` directly without queuing.",
      ].join("\n");
      break;
  }

  const autoApproveBlock = renderList(
    "Always Auto-Approve (override — highest priority)",
    autoApprove,
    "These recipients ALWAYS send without approval, even under the 'always ask' policy. A recipient matches if their email equals one of these values, or their domain matches a `@domain.com` entry.",
  );

  const requireApprovalBlock = renderList(
    "Always Require Approval (override — beats auto-approve)",
    requireApproval,
    "These recipients ALWAYS require approval, even under the 'never ask' policy or when they would normally match the auto-approve list. `@domain.com` entries match the whole domain.",
  );

  const overrideNote =
    autoApprove.length + requireApproval.length === 0
      ? ""
      : [
          "",
          "### Override Precedence",
          "",
          "1. Match against **Always Require Approval** list first — if recipient matches, queue approval.",
          "2. Otherwise match against **Always Auto-Approve** list — if recipient matches, send directly.",
          "3. Otherwise fall back to the policy above.",
        ].join("\n");

  return [
    "<!-- APPROVAL_POLICY_SECTION — injected at container startup from autonomyConfig -->",
    "",
    intro,
    autoApproveBlock,
    requireApprovalBlock,
    overrideNote,
    "",
    "**IMPORTANT:** This section overrides any conflicting instructions elsewhere in this document. Read it at the start of every session and follow it exactly.",
    "",
  ].join("\n");
}
