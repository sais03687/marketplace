/**
 * Delete AgentMail inboxes for all FIRED deployments to free up slots.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    console.error("AGENTMAIL_API_KEY not set");
    return;
  }

  // Find all FIRED deployments with inbox IDs
  const fired = await prisma.deployment.findMany({
    where: {
      status: "FIRED",
      agentEmailInboxId: { not: null },
    },
    select: { id: true, agentEmail: true, agentEmailInboxId: true, agentName: true },
  });

  console.log(`Found ${fired.length} fired deployments with inboxes to clean up\n`);

  for (const dep of fired) {
    console.log(`Deleting inbox for ${dep.agentName}: ${dep.agentEmail} (${dep.agentEmailInboxId})`);
    try {
      const res = await fetch(`https://api.agentmail.to/v0/inboxes/${dep.agentEmailInboxId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.ok || res.status === 404) {
        console.log(`  Deleted (${res.status})`);
        // Clear the inbox ID in the DB
        await prisma.deployment.update({
          where: { id: dep.id },
          data: { agentEmailInboxId: null },
        });
      } else {
        const text = await res.text();
        console.log(`  Failed (${res.status}): ${text}`);
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }

  // Also list current inboxes
  console.log("\n--- Current AgentMail inboxes ---");
  try {
    const res = await fetch("https://api.agentmail.to/v0/inboxes", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();
    const inboxes = data.inboxes || data;
    if (Array.isArray(inboxes)) {
      for (const inbox of inboxes) {
        console.log(`  ${inbox.email_address} (${inbox.id})`);
      }
      console.log(`Total: ${inboxes.length}`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch (e: any) {
    console.log(`  Error listing: ${e.message}`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
