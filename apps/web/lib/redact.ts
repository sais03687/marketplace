/**
 * Strip credentials from a record before it is returned to a browser.
 *
 * The deployment routes returned the whole Prisma row, so every buyer's
 * dashboard received the deployment's approvalWebhookToken and portalToken -
 * the credentials the agent container uses to talk to the platform - and, via
 * the included agent, the creator's packageUrl (a download link for their
 * source). No page read any of them; they were along for the ride.
 *
 * Matched by field name rather than listed one by one, so a secret column added
 * later is withheld without anyone remembering to add it here. The pattern is
 * deliberately broad: a field withheld by mistake shows up as a missing value
 * in the UI, a field leaked by mistake shows up nowhere.
 */
const SECRET_FIELD = /(token|secret|password|apikey|api_key|privatekey|serviceaccountkey|packageurl)$/i;

export function isSecretField(name: string): boolean {
  return SECRET_FIELD.test(name.replace(/[^a-z_]/gi, ""));
}

export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as T;
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretField(k)) continue;
    out[k] = redactSecrets(v);
  }
  return out as T;
}
