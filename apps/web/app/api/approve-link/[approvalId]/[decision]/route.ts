import { prisma } from "@/lib/db";
import { approvalLinkTokenMatches } from "@/lib/approval-link";
import { resolveApprovalAndUpdateTrust } from "@/lib/resolve-approval";

/**
 * Resolves one approval from the buttons in a notification email.
 *
 * POST only, and that is the point: the link in the email goes to a confirmation
 * page, not here. Mail scanners follow links to check them, so anything that
 * mutated on GET would be resolved by a scanner before the buyer ever read it.
 *
 * Authenticated by a token derived from the approval id, which authorises this
 * approval and nothing else — see lib/approval-link.ts.
 */
function page(title: string, message: string, tone: "ok" | "bad" = "ok"): Response {
  const colour = tone === "ok" ? "#15803d" : "#b91c1c";
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;width:100%;background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:32px;">
    <h1 style="margin:0 0 12px;font-size:20px;font-weight:600;color:${colour};">${title}</h1>
    <p style="margin:0;font-size:14px;color:#3f3f46;line-height:1.5;">${message}</p>
  </div>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ approvalId: string; decision: string }> },
) {
  const { approvalId, decision } = await params;
  const token = new URL(request.url).searchParams.get("t") ?? "";

  if (decision !== "approve" && decision !== "reject") {
    return page("Unknown action", "That link isn't valid.", "bad");
  }

  if (!approvalLinkTokenMatches(token, approvalId)) {
    return page(
      "This link isn't valid",
      "Open the agent's Approvals page in your dashboard to decide there.",
      "bad",
    );
  }

  const approval = await prisma.approval.findUnique({
    where: { id: approvalId },
    select: { id: true, status: true, deploymentId: true, expiresAt: true },
  });

  if (!approval) {
    return page(
      "This link isn't valid",
      "Open the agent's Approvals page in your dashboard to decide there.",
      "bad",
    );
  }

  // Whoever clicks second is told plainly rather than silently overwriting the
  // first decision — two people can be reading the same notification.
  if (approval.status !== "PENDING") {
    return page(
      "Already decided",
      `This request was already ${approval.status.toLowerCase()}. Nothing has changed.`,
    );
  }

  if (approval.expiresAt.getTime() < Date.now()) {
    return page(
      "This request has expired",
      "It is no longer actionable. Ask the agent again if you still want it done.",
      "bad",
    );
  }

  let reason = "";
  try {
    const form = await request.formData();
    reason = String(form.get("reason") ?? "").slice(0, 2000);
  } catch {
    // No body is fine — Approve sends none.
  }

  await resolveApprovalAndUpdateTrust({
    approvalId,
    deploymentId: approval.deploymentId,
    action: decision === "approve" ? "APPROVED" : "REJECTED",
    resolvedBy: "email-button",
    rejectionReason: decision === "reject" ? reason || "Rejected from email" : undefined,
  });

  return decision === "approve"
    ? page("Approved", "Your agent has been told to go ahead. You can close this tab.")
    : page("Rejected", "Your agent has been told not to proceed. You can close this tab.");
}
