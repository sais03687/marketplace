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
  {
    name: "credit_card",
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: "[CC]",
  },
  {
    name: "phone",
    regex: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE]",
  },
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
