import crypto from "node:crypto";

/**
 * Per-deployment credential that agent containers present to the platform.
 *
 * Mirrors apps/provisioning-service/src/utils/agent-token.ts — the two must agree,
 * since one derives the token and the other verifies it. It is deliberately a
 * derivation rather than a stored secret: nothing to migrate, nothing to leak from
 * the database, and both sides can compute it from the platform secret plus the
 * deployment id.
 *
 * A container can only ever present the token it was given, so it authenticates as
 * exactly one deployment and cannot be replayed against another company's.
 */
export function agentTokenFor(deploymentId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(deploymentId).digest("hex");
}

/** Constant-time compare, so a wrong token can't be discovered a byte at a time. */
export function agentTokenMatches(
  presented: string,
  deploymentId: string,
  secret: string,
): boolean {
  if (!secret || !presented) return false;
  const expected = agentTokenFor(deploymentId, secret);
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
