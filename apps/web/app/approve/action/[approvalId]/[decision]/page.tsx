import { prisma } from "@/lib/db";
import { approvalLinkTokenMatches } from "@/lib/approval-link";

/**
 * Confirmation page for an Approve/Reject button in a notification email.
 *
 * This page deliberately does nothing on load. Corporate mail security —
 * Defender Safe Links and every scanner of that kind — fetches the links in an
 * email to check them, so a link that resolved an approval on GET would let a
 * scanner silently approve actions nobody had looked at. Since approvals gate
 * file sharing, that is worse than having no buttons at all.
 *
 * So the decision is made by the form below, which POSTs. A prefetch renders
 * this page and changes nothing.
 */
export const dynamic = "force-dynamic";

function Shell({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#f4f4f5",
        fontFamily:
          "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 560,
          width: "100%",
          background: "#fff",
          border: "1px solid #e4e4e7",
          borderRadius: 8,
          padding: 32,
        }}
      >
        <h1 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 600, color: "#18181b" }}>
          {title}
        </h1>
        {body}
      </div>
    </main>
  );
}

export default async function ApprovalActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ approvalId: string; decision: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { approvalId, decision } = await params;
  const { t } = await searchParams;

  if (decision !== "approve" && decision !== "reject") {
    return <Shell title="Unknown action" body={<p>That link isn&apos;t valid.</p>} />;
  }

  // Same shape for a bad token and a missing approval, so the page cannot be used
  // to discover which approval ids exist.
  if (!t || !approvalLinkTokenMatches(t, approvalId)) {
    return (
      <Shell
        title="This link isn't valid"
        body={
          <p style={{ color: "#3f3f46", fontSize: 14, lineHeight: 1.5 }}>
            It may have been mistyped or truncated by an email client. Open the agent&apos;s
            Approvals page in your dashboard to decide there.
          </p>
        }
      />
    );
  }

  const approval = await prisma.approval.findUnique({
    where: { id: approvalId },
    select: {
      id: true,
      status: true,
      taskType: true,
      draft: true,
      reasoning: true,
      createdAt: true,
      expiresAt: true,
      deployment: { select: { agentName: true } },
    },
  });

  if (!approval) {
    return (
      <Shell
        title="This link isn't valid"
        body={
          <p style={{ color: "#3f3f46", fontSize: 14, lineHeight: 1.5 }}>
            It may have been mistyped or truncated by an email client. Open the agent&apos;s
            Approvals page in your dashboard to decide there.
          </p>
        }
      />
    );
  }

  if (approval.status !== "PENDING") {
    return (
      <Shell
        title="Already decided"
        body={
          <p style={{ color: "#3f3f46", fontSize: 14, lineHeight: 1.5 }}>
            This request was already <strong>{approval.status.toLowerCase()}</strong>. Nothing
            has changed — you can close this tab.
          </p>
        }
      />
    );
  }

  if (approval.expiresAt.getTime() < Date.now()) {
    return (
      <Shell
        title="This request has expired"
        body={
          <p style={{ color: "#3f3f46", fontSize: 14, lineHeight: 1.5 }}>
            It was raised on {approval.createdAt.toUTCString()} and is no longer actionable.
            Ask the agent again if you still want it done.
          </p>
        }
      />
    );
  }

  const approving = decision === "approve";
  const agentName = approval.deployment?.agentName ?? "Your agent";

  return (
    <Shell
      title={approving ? `Approve this action?` : `Reject this action?`}
      body={
        <>
          <p style={{ margin: "0 0 8px", fontSize: 14, color: "#71717a" }}>
            <strong style={{ color: "#18181b" }}>{agentName}</strong> — {approval.taskType}
          </p>
          <pre
            style={{
              margin: "0 0 16px",
              fontSize: 13,
              color: "#3f3f46",
              background: "#f4f4f5",
              padding: 12,
              borderRadius: 6,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {approval.draft}
          </pre>
          {approval.reasoning ? (
            <p style={{ margin: "0 0 24px", fontSize: 13, color: "#71717a", lineHeight: 1.5 }}>
              {approval.reasoning}
            </p>
          ) : null}

          <form method="POST" action={`/api/approve-link/${approval.id}/${decision}?t=${t}`}>
            {approving ? null : (
              <textarea
                name="reason"
                placeholder="Why are you rejecting this? (optional — the agent sees this)"
                rows={3}
                style={{
                  width: "100%",
                  marginBottom: 16,
                  padding: 10,
                  fontSize: 14,
                  borderRadius: 6,
                  border: "1px solid #e4e4e7",
                  fontFamily: "inherit",
                  boxSizing: "border-box",
                }}
              />
            )}
            <button
              type="submit"
              style={{
                display: "inline-block",
                background: approving ? "#15803d" : "#b91c1c",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                border: "none",
                padding: "10px 20px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {approving ? "Yes, approve it" : "Yes, reject it"}
            </button>
          </form>

          <p style={{ margin: "24px 0 0", fontSize: 12, color: "#a1a1aa" }}>
            Nothing happens until you press the button above.
          </p>
        </>
      }
    />
  );
}
