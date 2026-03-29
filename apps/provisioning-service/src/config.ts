import { resolve } from "node:path";

export const config = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  runnerMode: (process.env.RUNNER_MODE || "local") as "docker" | "local",
  openclawImage: process.env.OPENCLAW_IMAGE || "marketplace/agent-runner:latest",
  databaseUrl: process.env.DATABASE_URL || "postgresql://marketplace:marketplace@localhost:5432/marketplace",
  agentMailApiKey: process.env.AGENTMAIL_API_KEY || "",
  agentMailApiBase: process.env.AGENTMAIL_API_BASE || "https://api.agentmail.to/v0",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  approvalWebhookUrl: process.env.MARKETPLACE_APPROVAL_WEBHOOK || "http://localhost:3002",
  approvalWebhookToken: process.env.APPROVAL_WEBHOOK_TOKEN || "",
  agentPackagePath: process.env.AGENT_PACKAGE_PATH || "../../agents/v5-agent-package",
  customStarterPath: process.env.CUSTOM_STARTER_PATH || "../../agents/langchain-starter",
  customAdapterPath: process.env.CUSTOM_ADAPTER_PATH || "",

  // OpenClaw integration
  openclawDir: resolve(process.env.OPENCLAW_DIR || "../../openclaw"),
  openclawHooksToken: process.env.OPENCLAW_HOOKS_TOKEN || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",

  // Featherless AI (OpenAI-compatible LLM)
  llmApiKey: process.env.LLM_API_KEY || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.featherless.ai/v1",
  llmModel: process.env.LLM_MODEL || "Qwen/Qwen3-14B",

  // Google Calendar integration
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",

  // Google Workspace (Drive/Sheets/Docs) — service account auth
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "",

  healthCheckIntervalMs: 5000,
  healthCheckTimeoutMs: 120_000,
  maxRetries: 3,
} as const;
