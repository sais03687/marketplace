/**
 * Version numbers are assigned by the platform: 1, 2, 3, one per upload.
 *
 * Creators used to type a semver string in marketplace.json and bump it by hand,
 * which bought nothing — versions are only ever compared for equality — and cost
 * a refused upload every time someone forgot. Whatever the manifest says is now
 * ignored. Agents published before 2026-10-16 keep their old "1.1.2"-style rows;
 * the next upload simply counts them.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** The number the next upload of this agent gets: one more than the uploads so far. */
export async function nextVersionNumber(db: Db, agentId: string): Promise<string> {
  const rows = await db.agentVersion.findMany({ where: { agentId }, select: { version: true } });
  const taken = new Set(rows.map((r) => r.version));
  let n = rows.length + 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

/** A fingerprint of a package's files, so an unchanged re-upload can be refused. */
export function packageHash(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    // The manifest's own version field is ignored, so it must not make two
    // otherwise identical packages look different.
    if (name === "marketplace.json") {
      try {
        const m = JSON.parse(files.get(name)!.toString("utf-8"));
        delete m.version;
        h.update(name).update("\0").update(JSON.stringify(m)).update("\0");
        continue;
      } catch {
        // fall through and hash the bytes
      }
    }
    h.update(name).update("\0").update(files.get(name)!).update("\0");
  }
  return h.digest("hex");
}

/**
 * The version an identical package was last uploaded as, if the latest upload is
 * this same package. Stops the GitHub workflow publishing a new version on every
 * push that did not change the agent.
 */
export async function unchangedSince(db: Db, agentId: string, hash: string): Promise<string | null> {
  const latest = await db.agentVersion.findFirst({
    where: { agentId },
    orderBy: { createdAt: "desc" },
    select: { version: true, manifestData: true },
  });
  const prior = (latest?.manifestData as Record<string, unknown> | null)?._packageHash;
  return latest && prior === hash ? latest.version : null;
}

/** Older uploads still awaiting review are replaced by the new one, so only one waits. */
export async function supersedePending(db: Db, agentId: string, newVersionId: string, newVersion: string) {
  await db.agentVersion.updateMany({
    where: { agentId, vetStatus: "PENDING", id: { not: newVersionId } },
    data: { vetStatus: "FAILED", vetNotes: `Replaced by version ${newVersion} before it was reviewed` },
  });
}
