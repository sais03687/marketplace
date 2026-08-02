import crypto from "node:crypto";

/**
 * Per-deployment credential for agent containers calling back into this service.
 *
 * Agent containers need to reach /internal/microsoft-token to get a Graph token.
 * That endpoint used to accept a bare deploymentId with no authentication at all,
 * so any container that could reach host.docker.internal:3003 could mint a token
 * for *any* deployment — including another company's tenant.
 *
 * The obvious fix, handing containers PROVISIONING_SECRET, would be worse: that
 * secret authorises every internal route, including deprovision, and the code
 * running in those containers is written by third-party creators.
 *
 * So each deployment gets its own token, derived from the platform secret and its
 * own id. A container can present only the token it was given, which validates for
 * exactly one deployment. Derivation means no schema migration and no storage —
 * the value is recomputed on both sides.
 *
 * This narrows blast radius; it does not make the token safe to leak. Creator code
 * still holds it, which is what removing the raw Graph token entirely is meant to
 * address separately.
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
