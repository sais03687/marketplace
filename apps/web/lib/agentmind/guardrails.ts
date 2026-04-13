import { z } from "zod";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SanitizationResult {
  passed: boolean;
  sanitizedContent: string;
  log: { stage: string; action: string; details?: string }[];
  rejectionReason?: string;
}

export const contributionInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  type: z.enum(["CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"]),
  tags: z.array(z.string().min(1).max(50)).min(1).max(10),
  context: z.string().max(5000).optional(),
});

export type ContributionInput = z.infer<typeof contributionInputSchema>;

// ─── Stage 1: Schema Validation ─────────────────────────────────────────────

function validateSchema(input: unknown): {
  passed: boolean;
  data?: ContributionInput;
  log: SanitizationResult["log"];
  rejectionReason?: string;
} {
  const result = contributionInputSchema.safeParse(input);
  if (!result.success) {
    const details = result.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return {
      passed: false,
      log: [{ stage: "schema", action: "rejected", details }],
      rejectionReason: `Schema validation failed: ${details}`,
    };
  }
  return {
    passed: true,
    data: result.data,
    log: [{ stage: "schema", action: "passed" }],
  };
}

// ─── Stage 2: Regex PII Scrubber ────────────────────────────────────────────

const PII_PATTERNS: { name: string; regex: RegExp; replacement: string }[] = [
  // ── Identity & contact ──
  {
    name: "email",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[EMAIL]",
  },
  {
    name: "ssn",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN]",
  },
  // ── Financial (before phone — phone regex can match digit substrings) ──
  {
    name: "credit_card",
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,4}\b/g,
    replacement: "[CC]",
  },
  {
    name: "iban",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}[A-Z0-9\d]{7,25}\b/g,
    replacement: "[IBAN]",
  },
  {
    name: "dollar_amount",
    regex: /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/g,
    replacement: "[AMOUNT]",
  },
  // ── Network & infrastructure ──
  {
    name: "ip_address",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[IP]",
  },
  {
    name: "url_with_token",
    regex: /https?:\/\/[^\s]*[?&](token|key|secret|auth|password|api_key|apikey|access_token)=[^\s&]*/gi,
    replacement: "[URL]",
  },
  {
    name: "file_path_unix",
    regex: /(?:\/(?:home|Users|var|etc|tmp)\/[^\s]{5,})/g,
    replacement: "[PATH]",
  },
  {
    name: "file_path_windows",
    regex: /[A-Z]:\\(?:Users|Documents|AppData)\\[^\s]{5,}/gi,
    replacement: "[PATH]",
  },
  // ── API keys & tokens ──
  {
    name: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: "[BEARER]",
  },
  {
    name: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[JWT]",
  },
  {
    name: "generic_api_key",
    regex: /\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{20,}\b/gi,
    replacement: "[API_KEY]",
  },
  {
    name: "aws_access_key",
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[AWS_KEY]",
  },
  {
    name: "aws_secret_key",
    regex: /\b[A-Za-z0-9/+=]{40}\b/g,
    replacement: "[AWS_SECRET]",
  },
  {
    name: "github_token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
    replacement: "[GH_TOKEN]",
  },
  {
    name: "slack_token",
    regex: /\bxox[bporas]-[A-Za-z0-9\-]{10,}\b/g,
    replacement: "[SLACK_TOKEN]",
  },
  {
    name: "stripe_key",
    regex: /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{20,}\b/g,
    replacement: "[STRIPE_KEY]",
  },
  {
    name: "openai_key",
    regex: /\bsk-[A-Za-z0-9]{32,}\b/g,
    replacement: "[OPENAI_KEY]",
  },
  {
    name: "private_key_block",
    regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    replacement: "[PRIVATE_KEY]",
  },
  // ── Google IDs ──
  {
    name: "google_doc_id",
    regex: /\b(?:docs|sheets|drive)\.google\.com\/[^\s]*\/d\/([A-Za-z0-9_-]{25,})/g,
    replacement: "[GDOC_URL]",
  },
  // ── Passwords in config ──
  {
    name: "password_value",
    regex: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{4,}["']?/gi,
    replacement: "[PASSWORD]",
  },
  {
    name: "connection_string",
    regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/gi,
    replacement: "[CONN_STRING]",
  },
  // ── Phone (last — its greedy digit matching can corrupt tokens above) ──
  {
    name: "phone",
    regex: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE]",
  },
];

function scrubPii(text: string): {
  sanitized: string;
  log: SanitizationResult["log"];
} {
  let sanitized = text;
  const log: SanitizationResult["log"] = [];

  for (const pattern of PII_PATTERNS) {
    const matches = sanitized.match(pattern.regex);
    if (matches && matches.length > 0) {
      sanitized = sanitized.replace(pattern.regex, pattern.replacement);
      log.push({
        stage: "pii_scrub",
        action: "redacted",
        details: `${pattern.name}: ${matches.length} occurrence(s)`,
      });
    }
  }

  if (log.length === 0) {
    log.push({ stage: "pii_scrub", action: "passed" });
  }

  return { sanitized, log };
}

// ─── Stage 3: Entropy Filter ────────────────────────────────────────────────

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = s.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const ENTROPY_THRESHOLD = 4.5;
const MIN_TOKEN_LENGTH = 20;

function filterEntropy(text: string): {
  sanitized: string;
  log: SanitizationResult["log"];
} {
  const tokens = text.split(/\s+/);
  const log: SanitizationResult["log"] = [];
  let redactedCount = 0;

  const filtered = tokens.map((token) => {
    if (
      token.length > MIN_TOKEN_LENGTH &&
      shannonEntropy(token) > ENTROPY_THRESHOLD
    ) {
      redactedCount++;
      return "[HIGH_ENTROPY]";
    }
    return token;
  });

  if (redactedCount > 0) {
    log.push({
      stage: "entropy_filter",
      action: "redacted",
      details: `${redactedCount} high-entropy token(s)`,
    });
  } else {
    log.push({ stage: "entropy_filter", action: "passed" });
  }

  return { sanitized: filtered.join(" "), log };
}

// ─── Combined Pipeline ──────────────────────────────────────────────────────

export function runGuardrails(input: {
  title: string;
  content: string;
  type: string;
  tags: string[];
  context?: string;
}): SanitizationResult {
  // Stage 1: Schema validation
  const schemaResult = validateSchema(input);
  if (!schemaResult.passed) {
    return {
      passed: false,
      sanitizedContent: "",
      log: schemaResult.log,
      rejectionReason: schemaResult.rejectionReason,
    };
  }

  const allLogs: SanitizationResult["log"] = [...schemaResult.log];

  // Stage 2: PII scrubbing
  const piiResult = scrubPii(input.content);
  allLogs.push(...piiResult.log);

  // Stage 3: Entropy filter
  const entropyResult = filterEntropy(piiResult.sanitized);
  allLogs.push(...entropyResult.log);

  return {
    passed: true,
    sanitizedContent: entropyResult.sanitized,
    log: allLogs,
  };
}
