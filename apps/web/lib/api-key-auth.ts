import { createHash, randomBytes } from "crypto";
import { prisma } from "./db";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * A key that lets its holder publish agent code under a creator's name.
 *
 * randomBytes, not Math.random: Math.random is a PRNG meant for shuffling, not
 * for secrets — its output is guessable from previous values, and a key that
 * can be guessed is a way to publish code as somebody else. Keys issued before
 * 2026-09-23 came from Math.random and should be regenerated.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const bytes = randomBytes(32).toString("hex");
  const key = `mkt_${bytes}`;
  const prefix = key.slice(0, 12); // "mkt_" + 8 hex chars
  const hash = hashApiKey(key);
  return { key, prefix, hash };
}

/**
 * Validates a Bearer API key from the Authorization header.
 * Returns the creator if valid, null otherwise.
 * Also updates lastUsedAt on success.
 */
export async function validateApiKey(authHeader: string | null) {
  if (!authHeader?.startsWith("Bearer mkt_")) return null;

  const key = authHeader.slice("Bearer ".length);
  const hash = hashApiKey(key);

  const record = await prisma.creatorApiKey.findUnique({
    where: { keyHash: hash },
    include: { creator: true },
  });

  if (!record) return null;

  // Fire-and-forget lastUsedAt update
  prisma.creatorApiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return record.creator;
}
