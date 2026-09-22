/**
 * redact.ts — strip platform secrets out of anything shown to a creator.
 *
 * The vetting report quotes the sandbox container's own output, and creators can
 * read their own reports. Brokering the LLM key means the sandbox no longer holds
 * one, so nothing should reach a report in the first place; this is the second
 * layer, for the case where some other path puts a live value in front of code we
 * have not reviewed.
 *
 * Values, not patterns: a pattern guesses at what a key looks like, and guesses
 * wrong when a provider changes its prefix. Every value here is one this process
 * actually holds.
 */

const SECRET_ENV_VARS = [
  "LLM_API_KEY",
  "LLM_BROKER_KEY",
  "OPENROUTER_API_KEY",
  "VET_LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "PROVISIONING_SECRET",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "MICROSOFT_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
];

/**
 * Short values are skipped: a secret env var set to something like "1" or
 * "vet-noop" would otherwise match everywhere and redact ordinary words.
 */
function currentSecrets(): string[] {
  const seen = new Set<string>();
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length >= 12) seen.add(value);
  }
  return [...seen];
}

export function redactSecrets<T>(value: T): T {
  const secrets = currentSecrets();
  if (secrets.length === 0) return value;

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let out = node;
      for (const secret of secrets) {
        if (out.includes(secret)) out = out.split(secret).join("[redacted]");
      }
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) copy[k] = walk(v);
      return copy;
    }
    return node;
  };

  return walk(value) as T;
}
