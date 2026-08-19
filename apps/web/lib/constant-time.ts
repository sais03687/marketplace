import crypto from "node:crypto";

/**
 * Constant-time secret comparison.
 *
 * Its own module, with no imports beyond node's crypto, so it can be exercised
 * directly — the version that lived beside a Prisma import could only be tested
 * by reading it, and reading is what missed that /approvals/auto-complete
 * compared the same kind of token with `!==` while approval-link.ts next door
 * used timingSafeEqual "so a token cannot be discovered a byte at a time".
 */
export function tokensMatch(presented: string, expected: string | null | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the guard comes first:
  // otherwise a wrong-length token crashes the route instead of being refused
  // by it. The lengths are not the secret.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
