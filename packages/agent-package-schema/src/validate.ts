import type { AgentCategory, MarketplaceManifest } from "./types.js";
import { VALID_INTEGRATIONS } from "./types.js";

export interface ValidationError {
  field: string;
  message: string;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const VALID_CATEGORIES: Set<string> = new Set([
  "SALES_OPERATIONS",
  "CUSTOMER_SUCCESS",
  "EXECUTIVE_ASSISTANT",
  "RESEARCH",
  "MARKETING_OPS",
  "HR_OPS",
  "FINANCE_OPS",
  "ENGINEERING_OPS",
  "IT_SUPPORT",
  "GENERAL",
]);

const VALID_TIERS: Set<string> = new Set(["haiku", "sonnet", "opus"]);

/** The only runtimes that may be published. Exported so the creator UI can warn
 *  about a dead runtime using the same list the validator rejects on, rather
 *  than hardcoding "custom" in a second place and drifting from it. */
export const VALID_RUNTIMES: Set<string> = new Set(["custom"]);

export function validateManifest(m: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!m || typeof m !== "object") {
    return [{ field: "root", message: "Manifest must be a non-null object" }];
  }

  const manifest = m as Record<string, unknown>;

  // Required string fields
  for (const field of ["name", "slug", "tagline", "description", "version"] as const) {
    if (typeof manifest[field] !== "string" || (manifest[field] as string).trim() === "") {
      errors.push({ field, message: `${field} is required and must be a non-empty string` });
    }
  }

  // Slug format
  if (typeof manifest.slug === "string" && !SLUG_RE.test(manifest.slug)) {
    errors.push({ field: "slug", message: "slug must be lowercase alphanumeric with hyphens (e.g. my-agent)" });
  }

  // Semver
  if (typeof manifest.version === "string" && !SEMVER_RE.test(manifest.version)) {
    errors.push({ field: "version", message: "version must be semver (e.g. 1.0.0)" });
  }

  // Category enum
  if (!VALID_CATEGORIES.has(manifest.category as string)) {
    errors.push({ field: "category", message: `category must be one of: ${[...VALID_CATEGORIES].join(", ")}` });
  }

  // Model tier enum
  if (!VALID_TIERS.has(manifest.modelTier as string)) {
    errors.push({ field: "modelTier", message: `modelTier must be one of: haiku, sonnet, opus` });
  }

  // Price in cents (integer)
  if (typeof manifest.pricePerMonth !== "number" || manifest.pricePerMonth < 0) {
    errors.push({ field: "pricePerMonth", message: "pricePerMonth must be a non-negative number (in USD cents)" });
  }

  // Capabilities must be array of { name, description }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push({ field: "capabilities", message: "capabilities must be a non-empty array of { name, description }" });
  } else {
    for (let i = 0; i < manifest.capabilities.length; i++) {
      const cap = manifest.capabilities[i] as Record<string, unknown>;
      if (!cap || typeof cap.name !== "string" || typeof cap.description !== "string") {
        errors.push({ field: `capabilities[${i}]`, message: "each capability must have name and description strings" });
      }
    }
  }

  // Required arrays
  for (const field of ["requiredTools", "requiredIntegrations"] as const) {
    if (!Array.isArray(manifest[field])) {
      errors.push({ field, message: `${field} must be an array` });
    }
  }

  // Validate integration types against known platform integrations
  if (Array.isArray(manifest.requiredIntegrations)) {
    for (let i = 0; i < manifest.requiredIntegrations.length; i++) {
      const integration = manifest.requiredIntegrations[i] as string;
      if (!VALID_INTEGRATIONS.has(integration)) {
        errors.push({
          field: `requiredIntegrations[${i}]`,
          message: `Unknown integration "${integration}". Valid integrations: ${[...VALID_INTEGRATIONS].join(", ")}`,
        });
      }
    }
  }

  // Onboarding duration
  if (typeof manifest.onboardingDurationDays !== "number" || manifest.onboardingDurationDays < 0) {
    errors.push({ field: "onboardingDurationDays", message: "onboardingDurationDays must be a non-negative number" });
  }

  // Autonomy defaults
  if (!manifest.autonomyDefaults || typeof manifest.autonomyDefaults !== "object") {
    errors.push({ field: "autonomyDefaults", message: "autonomyDefaults is required" });
  }

  // Runtime (optional, defaults to "custom" — the only supported runtime)
  if (manifest.runtime !== undefined && !VALID_RUNTIMES.has(manifest.runtime as string)) {
    errors.push({ field: "runtime", message: `runtime must be one of: ${[...VALID_RUNTIMES].join(", ")}` });
  }

  // Heartbeat config (optional)
  if (manifest.heartbeat !== undefined) {
    const hb = manifest.heartbeat as Record<string, unknown>;
    if (typeof hb !== "object" || hb === null) {
      errors.push({ field: "heartbeat", message: "heartbeat must be an object" });
    } else if (hb.intervalHours !== undefined) {
      const h = hb.intervalHours as number;
      if (typeof h !== "number" || h < 1 || h > 24) {
        errors.push({ field: "heartbeat.intervalHours", message: "intervalHours must be a number between 1 and 24" });
      }
    }
  }

  // Runtime config (optional)
  if (manifest.runtimeConfig !== undefined) {
    const rc = manifest.runtimeConfig as Record<string, unknown>;
    if (typeof rc !== "object" || rc === null) {
      errors.push({ field: "runtimeConfig", message: "runtimeConfig must be an object" });
    } else if (rc.port !== undefined) {
      const port = rc.port as number;
      if (typeof port !== "number" || port < 1024 || port > 65535) {
        errors.push({ field: "runtimeConfig.port", message: "port must be a number between 1024 and 65535" });
      }
    }
  }

  return errors;
}

export function isValidManifest(m: unknown): m is MarketplaceManifest {
  return validateManifest(m).length === 0;
}
