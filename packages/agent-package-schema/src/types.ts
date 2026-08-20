import type { ModelTierName } from "./models.js";
// ─── Agent Runtime ──────────────────────────────────────────────────────────

// "openclaw" was retired — every agent runs in its own container built
// from the creator's package.
export type AgentRuntime = "custom";

// ─── Platform-Hosted Integrations ───────────────────────────────────────────
// These are MCP sidecar containers managed by the platform. Developers declare
// which integrations they need in their manifest; the platform spawns the
// corresponding sidecars and injects connection URLs as env vars.

export type PlatformIntegration = "python-sandbox";

export const VALID_INTEGRATIONS: Set<string> = new Set<string>([
  "python-sandbox",
]);

// ─── Agent Categories ────────────────────────────────────────────────────────

export type AgentCategory =
  | "SALES_OPERATIONS"
  | "CUSTOMER_SUCCESS"
  | "EXECUTIVE_ASSISTANT"
  | "RESEARCH"
  | "MARKETING_OPS"
  | "HR_OPS"
  | "FINANCE_OPS"
  | "ENGINEERING_OPS"
  | "IT_SUPPORT"
  | "GENERAL";

// ─── Autonomy Levels ─────────────────────────────────────────────────────────

export type AutonomyLevel =
  | "always_queue"
  | "queue_if_stakes_gt_5"
  | "queue_if_stakes_gt_7"
  | "auto_execute";

// ─── Marketplace Manifest ────────────────────────────────────────────────────

export interface MarketplaceManifest {
  name: string;
  slug: string;           // kebab-case, URL-safe, must be unique
  tagline: string;        // max 100 chars
  description: string;    // markdown, max 2000 chars
  category: AgentCategory;
  version: string;        // semver "1.0.0"
  pricePerMonth: number;  // USD cents, e.g. 49900 = $499/mo
  /**
   * Which model this agent runs on, by id from MODEL_CATALOGUE.
   *
   * When present the tier is derived from it and `modelTier` is ignored, so the
   * declared tier can never disagree with the model that actually answers. Kept
   * optional for manifests published before the catalogue existed; those still
   * run the platform default and keep the tier they declared.
   */
  model?: string;
  modelTier: ModelTierName;
  capabilities: Array<{ name: string; description: string }>;
  requiredTools: string[];
  requiredIntegrations: string[];  // "google-calendar" | "slack" | etc.
  autonomyDefaults: Record<string, AutonomyLevel>;
  runtime?: AgentRuntime;
  runtimeConfig?: { entrypoint?: string; port?: number };
  // Optional: if present, the platform schedules periodic heartbeat sessions
  // so the agent can do proactive maintenance (memory distillation, trust-tracker
  // review, workflow promotion, etc.) without waiting for inbound email.
  heartbeat?: {
    intervalHours?: number; // how often to wake the agent (default: 6)
  };
}

// ─── Onboarding ──────────────────────────────────────────────────────────────

export interface OnboardingQuestion {
  id: string;
  order: number;
  question: string;
  memoryKey: string;     // dot-path into MEMORY.md sections
  required: boolean;
  followUp?: string;
}

// ─── Agent Tests ─────────────────────────────────────────────────────────────

export interface AgentTest {
  id: string;
  name: string;
  description: string;
  input: {
    channel: "email" | "slack";
    content: string;
    context?: string;
  };
  expectedBehavior: {
    shouldQueue: boolean;
    shouldClarify: boolean;
    shouldNotDo: string[];
    outputContains?: string[];
    outputExcludes?: string[];
  };
}

// ─── Agent Package (full bundle) ─────────────────────────────────────────────

export interface AgentPackage {
  manifest: MarketplaceManifest;
  files: {
    soul: string;              // SOUL.md content
    agents: string;            // AGENTS.md content
    tools: string;             // TOOLS.md content
    skills: Record<string, string>;  // skill name → SKILL.md content
    onboardingQuestions: OnboardingQuestion[];
    memoryTemplate: string;           // MEMORY_TEMPLATE.md content
    examples: Array<{ taskType: string; input: string; output: string }>;
    tests: AgentTest[];
  };
}
