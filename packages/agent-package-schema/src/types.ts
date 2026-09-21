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
  /** Whole US dollars. Converted to cents on the way in, for Stripe. */
  pricePerMonth: number;
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
  // Optional: how platform_llm.StructuredLLM asks the model for structured
  // output. "auto" (default) picks per vendor; "none" is for an agent that
  // wants prose back, such as a chat agent. Passed in as STRUCTURED_OUTPUT.
  structuredOutput?: "auto" | "json" | "schema" | "none";
  /**
   * What this agent reaches in the buyer's Microsoft 365, declared up front.
   *
   * Two jobs. It is shown on the listing before anyone pays, in plain language,
   * so a buyer can compare an agent that wants files and mail against one that
   * wants to edit their directory. And the adapter enforces it: a Graph call
   * outside the declaration is refused, naming the scope that was missing, so a
   * creator meets it in the vetting sandbox rather than in someone's tenant.
   *
   * Optional, and omitting it changes no behaviour — every agent published
   * before this existed still runs. What omitting it does do is say so on the
   * listing, which is the point: declaring is cheap and looks better than not.
   *
   * These are not Graph scope strings. `Files.ReadWrite.All` means nothing to a
   * buyer, and a permission list nobody can read is decoration. Passed to the
   * container as GRAPH_SCOPES.
   */
  graphScopes?: GraphScope[];
}

/**
 * The vocabulary for `graphScopes`, deliberately small.
 *
 * Each entry maps to actions the adapter already classifies, so enforcement is
 * the gate that exists rather than a second one alongside it. A finer-grained
 * list would be more precise and less legible, and the buyer reading it is the
 * point.
 */
export const GRAPH_SCOPES = [
  "mail.read",
  "mail.send",
  "files.read",
  "files.write",
  "files.share",
  "excel.read",
  "excel.write",
  "calendar.read",
  "calendar.write",
  "directory.read",
] as const;

export type GraphScope = (typeof GRAPH_SCOPES)[number];

/** What a buyer is shown for each scope. Never the raw Graph permission. */
export const GRAPH_SCOPE_LABELS: Record<GraphScope, string> = {
  "mail.read": "Read email sent to it",
  "mail.send": "Send email as itself",
  "files.read": "Read files in your workspace",
  "files.write": "Create and update files",
  "files.share": "Share files with other people",
  "excel.read": "Read your spreadsheets",
  "excel.write": "Write to your spreadsheets",
  "calendar.read": "See your calendar",
  "calendar.write": "Create and change calendar events",
  "directory.read": "Look up people in your organisation",
};

// ─── Onboarding ──────────────────────────────────────────────────────────────

export interface OnboardingQuestion {
  id: string;
  order: number;
  question: string;
  memoryKey: string;     // dot-path into MEMORY.md sections
  required: boolean;
  followUp?: string;
  /**
   * Which hire tiers this question applies to. Omitted means both.
   *
   * A buyer on the email tier was asked "How is your SharePoint organized?"
   * on the first real hire (2026-09-18) — a tier with no SharePoint, where
   * every drive tool is withheld. Answering it is wasted effort, and being
   * asked implies a capability the agent does not have.
   *
   * Filtered server-side rather than left to the wording, for the same reason
   * the workspace tools are withheld rather than discouraged: a question a
   * creator was merely advised not to ask still gets asked.
   */
  tiers?: Array<"platform" | "buyer_org">;
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
