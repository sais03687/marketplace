/**
 * OpenRouter's key-management API, used with the account's management key.
 *
 * The management key cannot run models; it creates, changes and deletes the
 * account's other keys and reads their usage. It lives only in this service's
 * environment (OPENROUTER_MANAGEMENT_KEY) and never reaches a container or the
 * web app.
 *
 * Nothing here logs or throws a key's secret value: errors carry the HTTP
 * status and OpenRouter's error message only, and the secret comes back once,
 * from create, to the caller that stores it.
 */

const BASE = (process.env.OPENROUTER_MANAGEMENT_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const TIMEOUT_MS = 15_000;

export interface OpenRouterKeyInfo {
  hash: string;
  name: string;
  disabled: boolean;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  /** Lifetime spend in USD. */
  usage: number;
  usage_monthly: number;
}

export interface KeyManagementApi {
  create(opts: { name: string; limit: number; limitReset: "monthly" }): Promise<{ key: string; info: OpenRouterKeyInfo }>;
  get(hash: string): Promise<OpenRouterKeyInfo | null>;
  update(hash: string, patch: { disabled?: boolean; limit?: number }): Promise<OpenRouterKeyInfo>;
  remove(hash: string): Promise<void>;
  list(): Promise<OpenRouterKeyInfo[]>;
}

export function managementKeyConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_MANAGEMENT_KEY);
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) throw new Error("OPENROUTER_MANAGEMENT_KEY is not set");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404 && method !== "POST") return null;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Fall through to the status check with no body.
  }
  if (!res.ok) {
    const message = typeof json?.error?.message === "string" ? json.error.message.slice(0, 200) : "";
    throw new Error(`OpenRouter ${method} ${path.split("/").slice(0, 3).join("/")} failed: ${res.status} ${message}`.trim());
  }
  return json;
}

function info(d: any): OpenRouterKeyInfo {
  return {
    hash: String(d.hash),
    name: String(d.name ?? d.label ?? ""),
    disabled: Boolean(d.disabled),
    limit: typeof d.limit === "number" ? d.limit : null,
    limit_remaining: typeof d.limit_remaining === "number" ? d.limit_remaining : null,
    limit_reset: d.limit_reset ?? null,
    usage: Number(d.usage ?? 0),
    usage_monthly: Number(d.usage_monthly ?? 0),
  };
}

export const openRouterKeys: KeyManagementApi = {
  async create({ name, limit, limitReset }) {
    const json = await call("POST", "/keys", { name, limit, limit_reset: limitReset, include_byok_in_limit: true });
    if (typeof json?.key !== "string" || !json?.data?.hash) throw new Error("OpenRouter create key: unexpected response shape");
    return { key: json.key, info: info(json.data) };
  },
  async get(hash) {
    const json = await call("GET", `/keys/${encodeURIComponent(hash)}`);
    return json?.data ? info(json.data) : null;
  },
  async update(hash, patch) {
    const json = await call("PATCH", `/keys/${encodeURIComponent(hash)}`, patch);
    return info(json.data);
  },
  async remove(hash) {
    await call("DELETE", `/keys/${encodeURIComponent(hash)}`);
  },
  async list() {
    // Paged by offset, page size unknown. Stop on an empty page or one that adds
    // nothing new (an API ignoring offset would otherwise repeat page one), with
    // a hard ceiling either way.
    const seen = new Map<string, OpenRouterKeyInfo>();
    for (let offset = 0, page = 0; page < 50; page++) {
      const json = await call("GET", `/keys?offset=${offset}`);
      const rows: any[] = Array.isArray(json?.data) ? json.data : [];
      const before = seen.size;
      for (const r of rows) seen.set(String(r.hash), info(r));
      if (rows.length === 0 || seen.size === before) break;
      offset += rows.length;
    }
    return [...seen.values()];
  },
};
