import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  webAppRoot: process.env.WEB_APP_ROOT || resolve(__dirname, "../../web"),

  // OpenClaw integration
  openclawDir: resolve(process.env.OPENCLAW_DIR || "../../openclaw"),
  openclawHooksToken: process.env.OPENCLAW_HOOKS_TOKEN || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",

  // LLM for agent runtime (OpenRouter by default)
  llmApiKey: process.env.LLM_API_KEY || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  llmModel: process.env.LLM_MODEL || "google/gemini-2.5-flash",

  // Google Calendar integration
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "",

  // Google Workspace (Drive/Sheets/Docs) — service account auth
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "",

  // GCP project for per-deployment service account creation.
  gcpProjectId: process.env.GCP_PROJECT_ID || "",

  // Dedicated IAM provisioner key (base64-encoded JSON).
  // This SA only needs: serviceAccountCreator + serviceAccountDeleter + serviceAccountKeyAdmin.
  // Keep separate from the agent identity key (GOOGLE_SERVICE_ACCOUNT_KEY) so each SA
  // has the minimum permissions needed for its specific job.
  // Falls back to GOOGLE_SERVICE_ACCOUNT_KEY if not set (legacy / single-SA setups).
  gcpIamKey: process.env.GCP_IAM_KEY || "",

  // Platform-owned Google Workspace org (agents.[platform-domain].com)
  // One-time infrastructure bootstrap — credentials stored as platform secrets on Hetzner
  googleWorkspaceDomain: process.env.GOOGLE_WORKSPACE_DOMAIN || "",
  googleWorkspaceAdminEmail: process.env.GOOGLE_WORKSPACE_ADMIN_EMAIL || "",
  googleWorkspaceSaKey: process.env.GOOGLE_WORKSPACE_SA_KEY || "",

  // Platform-owned Microsoft 365 tenant (agents.[platform-domain].com)
  microsoftTenantId: process.env.MICROSOFT_TENANT_ID || "",
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || "",
  microsoftClientSecret: process.env.MICROSOFT_CLIENT_SECRET || "",

  // Vercel Blob — needed to list and download creator packages
  blobReadWriteToken: process.env.BLOB_READ_WRITE_TOKEN || "",
  blobBaseUrl: process.env.BLOB_BASE_URL || "",

  // Platform revenue split: fraction kept by the platform (0.30 = 30%).
  // Creators receive (1 - platformRevenueShare) of each month's subscription.
  platformRevenueShare: parseFloat(process.env.PLATFORM_REVENUE_SHARE || "0.30"),

  healthCheckIntervalMs: 5000,
  healthCheckTimeoutMs: 120_000,
  maxRetries: 3,
} as const;
