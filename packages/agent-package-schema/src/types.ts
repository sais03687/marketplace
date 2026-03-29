// ─── Agent Runtime ──────────────────────────────────────────────────────────

export type AgentRuntime = "openclaw" | "custom";

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
  modelTier: "haiku" | "sonnet" | "opus";
  capabilities: Array<{ name: string; description: string }>;
  requiredTools: string[];
  requiredIntegrations: string[];  // "google-calendar" | "slack" | etc.
  onboardingDurationDays: number;
  autonomyDefaults: Record<string, AutonomyLevel>;
  runtime?: AgentRuntime;
  runtimeConfig?: { entrypoint?: string; port?: number };
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
