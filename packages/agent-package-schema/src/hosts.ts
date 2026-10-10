/**
 * Outside sites an agent may reach, declared in its manifest as `connectsTo`.
 *
 * An agent's network has one way out — its gate — and the gate admits only the
 * platform's own hosts plus whatever is listed here. Each entry is shown to the
 * reviewer at vetting and to the buyer before they hire, so the list has to mean
 * exactly what it says: one host, matched exactly, by name.
 *
 * What is refused, and why:
 *  - wildcards, schemes, paths and ports: the entry is a host, nothing else;
 *  - IP addresses: a buyer cannot judge "203.0.113.7", and an address skips the
 *    name check the gate is built on;
 *  - names that only mean something inside a network (localhost, *.internal,
 *    *.local …): the gate also refuses private addresses, but a name like these
 *    is never a legitimate outside service, so it is turned away at upload with a
 *    reason rather than failing quietly at runtime.
 *
 * Kept in this package so the upload check, vetting, provisioning and the
 * listing page all read the same rules.
 */
export const MAX_DECLARED_HOSTS = 10;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_HOSTS = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
  "metadata.google.internal",
  "metadata",
]);

const RESERVED_SUFFIXES = [
  ".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet",
  ".private", ".arpa", ".test", ".invalid", ".example", ".onion",
];

/** Why `raw` cannot be declared, or null if it can. */
export function hostProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "each entry must be a host name in quotes";
  const host = raw.trim().toLowerCase();
  if (!host) return "an entry is empty";
  if (host.includes("://")) return `"${raw}" is a URL — give the host only, e.g. "api.example.com"`;
  if (/[\/?#]/.test(host)) return `"${raw}" has a path — give the host only`;
  if (host.includes("*")) return `"${raw}" is a wildcard — list each host exactly`;
  if (host.includes(":") || host.startsWith("[")) return `"${raw}" has a port or is an IPv6 address — give the host name only`;
  if (/\s/.test(host)) return `"${raw}" contains a space`;
  if (host.length > 253) return `"${raw}" is longer than a host name can be`;
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2) return `"${raw}" is not a full host name (expected something like api.example.com)`;
  if (!labels.every((l) => LABEL.test(l))) return `"${raw}" is not a valid host name`;
  if (/^\d+$/.test(labels[labels.length - 1])) return `"${raw}" is an IP address — declare the service's host name instead`;
  if (RESERVED_HOSTS.has(host) || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) {
    return `"${raw}" is a private or internal name, which agents cannot reach`;
  }
  return null;
}

/** Validate a manifest's `connectsTo` value. Hosts come back normalised (lowercase, no trailing dot). */
export function checkConnectsTo(value: unknown): { hosts: string[]; errors: string[] } {
  if (value === undefined || value === null) return { hosts: [], errors: [] };
  if (!Array.isArray(value)) return { hosts: [], errors: ["connectsTo must be a list of host names"] };
  const errors: string[] = [];
  const hosts: string[] = [];
  for (const entry of value) {
    const problem = hostProblem(entry);
    if (problem) {
      errors.push(problem);
      continue;
    }
    const host = (entry as string).trim().toLowerCase().replace(/\.$/, "");
    if (hosts.includes(host)) errors.push(`"${host}" is listed twice`);
    else hosts.push(host);
  }
  if (hosts.length > MAX_DECLARED_HOSTS) {
    errors.push(`connectsTo lists ${hosts.length} hosts; the most an agent may declare is ${MAX_DECLARED_HOSTS}`);
  }
  return { hosts, errors };
}

/**
 * The valid declared hosts of a stored or uploaded manifest, or none.
 *
 * For readers downstream of the upload check (provisioning, the listing). A
 * manifest that fails validation yields no hosts at all rather than the valid
 * part of a bad list: the safe reading of a list nobody approved is "nothing".
 */
export function declaredHosts(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  const { hosts, errors } = checkConnectsTo((manifest as Record<string, unknown>).connectsTo);
  return errors.length ? [] : hosts;
}

/** Hosts in `after` that `before` did not have — what a buyer has not agreed to. */
export function addedHosts(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((h) => !had.has(h));
}
