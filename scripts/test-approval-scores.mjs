// Test that POST /api/deployments/:id/approvals now persists real scores
const MARKETPLACE_URL = "http://localhost:3002";
const DEPLOYMENT_ID = "cmns7w7vj002crsew02jt4lc2";

const payload = {
  taskType: "cold-outreach",
  channel: "email",
  draft: "Hi John, I wanted to introduce you to our services...",
  reasoning: "User asked me to send a cold email; this requires approval because it's unsolicited external outreach with reputational risk.",
  stakesScore: 7.5,
  ambiguityScore: 4.0,
  reversibilityScore: 8.0,
  combinedScore: 6.5,
  threadId: "test-thread-scores",
  fromEmail: "test-langchain-agent-my-company@agentmail.to",
  subject: "Cold outreach to prospect",
  originalRequest: "Send a cold email to john.prospect@acmecorp.com",
};

const res = await fetch(
  `${MARKETPLACE_URL}/api/deployments/${DEPLOYMENT_ID}/approvals`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }
);
console.log("Status:", res.status);
const body = await res.json();
console.log("Response body:", JSON.stringify(body, null, 2));

if (body.approval?.id) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const row = await prisma.approval.findUnique({
    where: { id: body.approval.id },
    select: {
      id: true,
      taskType: true,
      stakesScore: true,
      ambiguityScore: true,
      reversibilityScore: true,
      combinedScore: true,
      threadId: true,
      reasoning: true,
    },
  });
  console.log("\nDB record:");
  console.log(JSON.stringify(row, null, 2));
  await prisma.approval.delete({ where: { id: body.approval.id } });
  console.log("\n(Cleaned up test approval)");
  await prisma.$disconnect();
}
