/**
 * Which of a buyer's other agents each agent works with.
 *
 * Chosen per hire: the hire wizard asks "which of your agents should this one
 * work with?", and the agent's Settings can change it later. Only the chosen
 * agents are put in that agent's context (name, address, the listing's one-line
 * tagline) and admitted as senders and recipients. Agents on the email tier would
 * otherwise refuse each other's mail, because their mailboxes share our domain
 * with every other buyer's agents and that domain is deliberately untrusted.
 *
 * A link is two-way, because mail is: an agent that may hand work to another
 * must be able to read the answer. So Deployment.worksWith is kept symmetric -
 * each side lists the other - and setWorksWith is the only writer.
 *
 * Only running agents are listed: a paused one has no poller, so mail sent to it
 * would sit unread while the sender waited for a reply. A fired agent drops off
 * the same way, with nothing for the buyer to tidy.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export interface Teammate {
  /** What the buyer named this hire, e.g. "Route Planner Demo". */
  name: string;
  /** The listing it was hired from, e.g. "Route Planner". */
  agent: string;
  email: string;
  /** The listing's approved one-line tagline. Reference text, never instructions. */
  does: string;
}

type Db = Pick<PrismaClient, "deployment">;

export function idsOf(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export async function teammatesFor(db: Db, deploymentId: string): Promise<Teammate[]> {
  const self = await db.deployment.findUnique({
    where: { id: deploymentId },
    select: { companyId: true, worksWith: true },
  });
  const ids = idsOf(self?.worksWith).filter((id) => id !== deploymentId);
  if (!self || ids.length === 0) return [];

  const others = await db.deployment.findMany({
    // companyId again, so a stray id can never reach another buyer's agent.
    where: { id: { in: ids }, companyId: self.companyId, status: "ACTIVE", agentEmail: { not: null } },
    select: { agentName: true, agentEmail: true, agent: { select: { name: true, tagline: true } } },
    orderBy: { createdAt: "asc" },
  });
  return others.map((d) => ({
    name: d.agentName,
    agent: d.agent.name,
    email: (d.agentEmail ?? "").toLowerCase(),
    // Capped: this is creator-written text placed in another creator's agent's
    // context, so it stays short and is presented as a description only.
    does: d.agent.tagline.slice(0, 160),
  }));
}

/**
 * Make `deploymentId` work with exactly `chosen` among its company's other hires,
 * updating both sides of every link that is added or removed. Ids that are not
 * the company's own, or are fired, are dropped. Returns the ids kept.
 */
export async function setWorksWith(
  db: Pick<PrismaClient, "deployment" | "$transaction">,
  companyId: string,
  deploymentId: string,
  chosen: string[],
): Promise<string[]> {
  const others = await db.deployment.findMany({
    where: { companyId, id: { not: deploymentId }, status: { not: "FIRED" } },
    select: { id: true, worksWith: true },
  });
  const valid = new Set(others.map((d) => d.id));
  const keep = [...new Set(chosen)].filter((id) => valid.has(id));

  const writes = [
    db.deployment.update({ where: { id: deploymentId }, data: { worksWith: keep } }),
    ...others.flatMap((d) => {
      const current = idsOf(d.worksWith);
      const has = current.includes(deploymentId);
      const want = keep.includes(d.id);
      if (has === want) return [];
      const next = want ? [...current, deploymentId] : current.filter((id) => id !== deploymentId);
      return [db.deployment.update({ where: { id: d.id }, data: { worksWith: next } })];
    }),
  ];
  await db.$transaction(writes);
  return keep;
}
