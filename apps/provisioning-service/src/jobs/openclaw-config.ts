import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export interface DeploymentOpenClawConfig {
  deploymentId: string;
  agentEmail: string;
  agentName: string;
  approvalWebhookUrl: string;
  approvalWebhookToken: string;
  gatewayPort: number;
  geminiApiKey: string;
  agentMailApiKey: string;
  hooksToken: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  googleServiceAccountEmail?: string;
  googleServiceAccountKey?: string;
  openrouterApiKey?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
}

/**
 * Generates an openclaw.json config + .env for a specific deployment.
 * Each deployment gets its own state directory so gateways are isolated.
 */
export function generateDeploymentConfig(
  dataDir: string,
  opts: DeploymentOpenClawConfig,
): { configPath: string; envPath: string; stateDir: string } {
  const stateDir = join(dataDir, "openclaw-state");
  mkdirSync(stateDir, { recursive: true });

  const hooksToken = opts.hooksToken || randomBytes(32).toString("hex");

  // Determine LLM provider + model
  const useLlm = !!opts.llmApiKey;
  const llmBaseUrl = opts.llmBaseUrl || "https://api.featherless.ai/v1";
  const llmModel = opts.llmModel || "Qwen/Qwen3-14B";

  // Generate the openclaw.json config
  const config: Record<string, unknown> = {
    gateway: {
      mode: "local",
      port: opts.gatewayPort,
    },
    agents: {
      defaults: {
        model: { primary: useLlm ? `featherless/${llmModel}` : "google/gemini-2.5-flash" },
      },
      list: [
        {
          id: "main",
          identity: {
            name: opts.agentName,
          },
        },
      ],
    },
    // Custom provider for Featherless AI (OpenAI-compatible)
    ...(useLlm
      ? {
          models: {
            mode: "merge",
            providers: {
              featherless: {
                baseUrl: llmBaseUrl,
                apiKey: "${FEATHERLESS_API_KEY}",
                api: "openai-completions",
                models: [
                  {
                    id: llmModel,
                    name: llmModel,
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        }
      : {}),
    plugins: {
      enabled: true,
      allow: ["agentmail-tools", "google-calendar-tools", "google-workspace-tools"],
      load: {
        paths: [join(homedir(), ".openclaw", "extensions")],
      },
      entries: {
        "agentmail-tools": {
          enabled: true,
          config: {
            inboxAddress: opts.agentEmail,
            approvalEndpoint: `${opts.approvalWebhookUrl}/api/deployments/${opts.deploymentId}`,
          },
        },
        ...(opts.googleRefreshToken
          ? {
              "google-calendar-tools": {
                enabled: true,
                config: {
                  googleClientId: opts.googleClientId,
                  googleClientSecret: opts.googleClientSecret,
                  googleRefreshToken: opts.googleRefreshToken,
                },
              },
            }
          : {}),
        ...(opts.googleServiceAccountKey
          ? {
              "google-workspace-tools": {
                enabled: true,
                config: {
                  serviceAccountEmail: opts.googleServiceAccountEmail,
                  serviceAccountKey: opts.googleServiceAccountKey,
                  // Personal OAuth for file creation (SA has 0 storage quota)
                  googleClientId: opts.googleClientId,
                  googleClientSecret: opts.googleClientSecret,
                  googleRefreshToken: opts.googleRefreshToken,
                },
              },
            }
          : {}),
      },
    },
    hooks: {
      enabled: true,
      token: hooksToken,
      path: "/hooks",
      defaultSessionKey: "hook:ingress",
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:"],
      mappings: [
        {
          id: "agentmail",
          match: { path: "agentmail" },
          action: "agent",
          wakeMode: "now",
          deliver: false,
          allowUnsafeExternalContent: true,
          name: "AgentMail",
          sessionKey: "hook:email:{{message.thread_id}}",
          messageTemplate: [
            "IMPORTANT: Your text output is NOT delivered to anyone.",
            " You MUST call the email_reply tool to send any response.",
            " Without a tool call, your response is invisible.",
            "\n\n[Email Thread: {{message.thread_id}}]",
            "\n[Reply-To: {{message.from}}]",
            "\nFrom: {{message.from}}",
            "\nTo: {{message.to}}",
            "\nSubject: {{message.subject}}",
            "\n\n{{message.text}}",
            '\n\n---\nTo reply, call email_reply with thread_id "{{message.thread_id}}"',
            " and your response as the text parameter.",
            " You may also pass an html parameter for rich formatting (tables, bold, links, etc.)",
            " — always include a plain text version too.",
          ].join(""),
        },
      ],
    },
  };

  const configPath = join(stateDir, "openclaw.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Generate .env for the deployment
  const envContent = [
    `OPENCLAW_GATEWAY_TOKEN=${randomBytes(32).toString("hex")}`,
    `OPENCLAW_HOOKS_TOKEN=${hooksToken}`,
    `GEMINI_API_KEY=${opts.geminiApiKey}`,
    `AGENTMAIL_API_KEY=${opts.agentMailApiKey}`,
    ...(opts.openrouterApiKey ? [`OPENROUTER_API_KEY=${opts.openrouterApiKey}`] : []),
    ...(opts.llmApiKey ? [`FEATHERLESS_API_KEY=${opts.llmApiKey}`] : []),
  ].join("\n");

  const envPath = join(stateDir, ".env");
  writeFileSync(envPath, envContent);

  return { configPath, envPath, stateDir };
}
