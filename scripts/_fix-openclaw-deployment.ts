/**
 * Fix the OPENCLAW deployment that failed during provisioning.
 * The gateway is running manually on port 18900. This script:
 * 1. Finds or creates the AgentMail inbox
 * 2. Sets the webhook to point to the gateway's /hooks/agentmail endpoint
 * 3. Updates the deployment record from ERROR to ONBOARDING
 * 4. Sends the onboarding intro email
 */
import { PrismaClient } from "@prisma/client";

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY || "am_us_418452a2d1d07f40fe418274c1ac9902d162d4036426399a4eb0ca383aea2e23";
const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";
const DEPLOYMENT_ID = "cmnvzw3wj0004rs9c139nsjpn";
const GATEWAY_PORT = 18900;
const HOOKS_TOKEN = "42de723527744bbfa202c4082bae63affe5bc600a4644d88990f5c4faa5c01b8";

async function agentMailFetch<T>(path: string, opts: { method?: string; body?: Record<string, unknown> } = {}): Promise<T> {
  const res = await fetch(`${AGENTMAIL_API_BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AgentMail API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

const prisma = new PrismaClient();

async function main() {
  // 1. Find or create the inbox
  const username = "general-ops-alex-test-company";
  const domain = "agentmail.to";
  const targetEmail = `${username}@${domain}`;

  console.log(`[1] Looking for existing inbox: ${targetEmail}`);

  let inboxId: string;
  let agentEmail: string;

  try {
    // Try creating first
    const raw = await agentMailFetch<{ inbox_id: string; email: string }>("/inboxes", {
      method: "POST",
      body: { username, domain },
    });
    inboxId = raw.inbox_id;
    agentEmail = raw.email;
    console.log(`    Created new inbox: ${agentEmail} (${inboxId})`);
  } catch (err: any) {
    // Already exists — find it
    console.log(`    Inbox already exists, looking up...`);
    const list = await agentMailFetch<{ inboxes: Array<{ inbox_id: string; email: string }> }>("/inboxes");
    const existing = list.inboxes.find((i: any) => i.email === targetEmail);
    if (!existing) {
      throw new Error(`Could not find inbox for ${targetEmail}`);
    }
    inboxId = existing.inbox_id;
    agentEmail = existing.email;
    console.log(`    Found existing inbox: ${agentEmail} (${inboxId})`);
  }

  // 2. Set the webhook to the gateway
  // The OpenClaw gateway's hooks config expects POST to /hooks/agentmail?token=<token>
  const webhookUrl = `http://localhost:${GATEWAY_PORT}/hooks/agentmail?token=${HOOKS_TOKEN}`;
  console.log(`[2] Setting webhook: ${webhookUrl}`);

  await agentMailFetch(`/inboxes/${encodeURIComponent(inboxId)}`, {
    method: "PATCH",
    body: { webhook_url: webhookUrl, display_name: "Alex" },
  });
  console.log(`    Webhook set successfully`);

  // 3. Update the deployment record
  console.log(`[3] Updating deployment ${DEPLOYMENT_ID} to ONBOARDING`);

  const deployment = await prisma.deployment.update({
    where: { id: DEPLOYMENT_ID },
    data: {
      status: "ONBOARDING",
      onboardingState: "INTERVIEW",
      containerName: `http://localhost:${GATEWAY_PORT}`,
      agentEmail,
      agentEmailInboxId: inboxId,
    },
    include: {
      agent: true,
      company: true,
    },
  });
  console.log(`    Updated: status=ONBOARDING, email=${agentEmail}`);

  // 4. Send onboarding intro email
  const managerEmail = deployment.weeklyDigestEmail || `admin@${deployment.company.domain}`;
  const agentName = deployment.agent.name;

  const introText = `Hi there!

I'm ${agentName}, your new AI employee. I've just been set up and I'm ready to help.

Here's what I can do:
  - Email management, research, and task execution
  - Google Workspace integration (Docs, Sheets, Drive)

I also have access to Google Workspace. To share Google Drive files, Sheets, or Docs with me, share them with: alex-agent@ai-employee-490819.iam.gserviceaccount.com

You can reach me anytime at ${agentEmail}. Just send me an email with what you need!

Looking forward to working with you.

Best,
${agentName}`;

  console.log(`[4] Sending intro email to ${managerEmail}`);

  const msg = await agentMailFetch<{ message_id: string; thread_id: string }>(
    `/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
    {
      method: "POST",
      body: {
        to: managerEmail,
        subject: `👋 Hi! I'm ${agentName}, your new AI employee`,
        text: introText,
      },
    },
  );
  console.log(`    Sent intro email: messageId=${msg.message_id}, threadId=${msg.thread_id}`);

  // 5. Quick health check on the gateway
  console.log(`[5] Health check on gateway port ${GATEWAY_PORT}...`);
  try {
    const res = await fetch(`http://localhost:${GATEWAY_PORT}/__openclaw__/health`);
    const data = await res.json();
    console.log(`    Gateway health:`, JSON.stringify(data));
  } catch {
    console.log(`    Gateway health endpoint not available (may use different path)`);
  }

  console.log(`\n✅ OPENCLAW deployment fixed and ready!`);
  console.log(`   Email: ${agentEmail}`);
  console.log(`   Gateway: http://localhost:${GATEWAY_PORT}`);
  console.log(`   Webhook: ${webhookUrl}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
