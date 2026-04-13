/**
 * Unit tests for guardrails PII patterns.
 * Run with: npx tsx apps/web/lib/agentmind/guardrails.test.ts
 */
import assert from "node:assert/strict";
import { runGuardrails } from "./guardrails.js";

function testPii(content: string, expectedTag: string, label: string) {
  const result = runGuardrails({
    title: "Test",
    content,
    type: "PATTERN",
    tags: ["test"],
  });
  assert.ok(
    result.sanitizedContent.includes(expectedTag),
    `${label}: expected "${expectedTag}" in "${result.sanitizedContent}"`,
  );
  assert.ok(
    !result.sanitizedContent.includes(content.split(" ")[0] === expectedTag ? "NEVER" : content),
    `${label}: original content should be scrubbed`,
  );
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

console.log("Guardrails PII Pattern Tests\n");

// ── Identity & Contact ──

test("email", () => {
  const r = runGuardrails({ title: "T", content: "Contact john@example.com for details", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[EMAIL]"));
  assert.ok(!r.sanitizedContent.includes("john@example.com"));
});

test("ssn", () => {
  const r = runGuardrails({ title: "T", content: "SSN is 123-45-6789", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[SSN]"));
});

test("phone", () => {
  const r = runGuardrails({ title: "T", content: "Call me at (555) 123-4567", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[PHONE]"));
});

// ── Financial ──

test("credit card", () => {
  const r = runGuardrails({ title: "T", content: "Card: 4111 1111 1111 1111", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[CC]"));
});

test("dollar amount", () => {
  const r = runGuardrails({ title: "T", content: "The budget is $1,250,000.00 for this quarter", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[AMOUNT]"));
});

test("iban", () => {
  const r = runGuardrails({ title: "T", content: "Wire to GB29NWBK60161331926819", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[IBAN]"));
});

// ── Network & Infrastructure ──

test("ip address", () => {
  const r = runGuardrails({ title: "T", content: "Server at 192.168.1.100", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[IP]"));
});

test("url with token", () => {
  const r = runGuardrails({ title: "T", content: "Visit https://api.example.com/data?api_key=secret123", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[URL]"));
});

test("unix file path", () => {
  const r = runGuardrails({ title: "T", content: "Config at /home/john/secrets/config.json", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[PATH]"));
});

test("windows file path", () => {
  const r = runGuardrails({ title: "T", content: "File at C:\\Users\\john\\Documents\\secret.txt", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[PATH]"));
});

// ── API Keys & Tokens ──

test("bearer token", () => {
  const r = runGuardrails({ title: "T", content: "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[BEARER]"));
});

test("jwt", () => {
  const r = runGuardrails({ title: "T", content: "Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[JWT]"));
});

test("generic api key (sk- prefix)", () => {
  const r = runGuardrails({ title: "T", content: "Use key sk-1234567890abcdef1234567890abcdef", type: "PATTERN", tags: ["t"] });
  assert.ok(
    r.sanitizedContent.includes("[API_KEY]") || r.sanitizedContent.includes("[OPENAI_KEY]"),
  );
});

test("aws access key", () => {
  const r = runGuardrails({ title: "T", content: "AWS key AKIAIOSFODNN7EXAMPLE", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[AWS_KEY]"));
});

test("github token", () => {
  const r = runGuardrails({ title: "T", content: "Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[GH_TOKEN]"));
});

test("slack token", () => {
  const r = runGuardrails({ title: "T", content: "Bot token xoxb-123456789-abcdefghij", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[SLACK_TOKEN]"));
});

test("stripe key", () => {
  const prefix = "sk_test_";
  const r = runGuardrails({ title: "T", content: `Stripe ${prefix}abcdef1234567890abcdef12`, type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[STRIPE_KEY]"));
});

test("private key block", () => {
  const r = runGuardrails({
    title: "T",
    content: "Here is the key -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----",
    type: "PATTERN",
    tags: ["t"],
  });
  assert.ok(r.sanitizedContent.includes("[PRIVATE_KEY]"));
});

// ── Google IDs ──

test("google doc url", () => {
  const r = runGuardrails({ title: "T", content: "See https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[GDOC_URL]"));
});

// ── Passwords & Connection Strings ──

test("password value", () => {
  const r = runGuardrails({ title: "T", content: "Set password=MyS3cretP@ss!", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[PASSWORD]"));
});

test("connection string (postgres)", () => {
  const r = runGuardrails({ title: "T", content: "DATABASE_URL=postgres://user:pass@localhost:5432/mydb", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[CONN_STRING]"));
});

test("connection string (mongodb)", () => {
  const r = runGuardrails({ title: "T", content: "Use mongodb://admin:password@cluster0.example.net/db", type: "PATTERN", tags: ["t"] });
  assert.ok(r.sanitizedContent.includes("[CONN_STRING]"));
});

// ── Clean content should pass through ──

test("clean content passes unchanged", () => {
  const clean = "Learned that stakeholders prefer bullet-point summaries over prose for weekly updates";
  const r = runGuardrails({ title: "Clean insight", content: clean, type: "PATTERN", tags: ["communication"] });
  assert.ok(r.passed);
  assert.equal(r.sanitizedContent, clean);
});

// ── Entropy filter ──

test("high entropy token is redacted", () => {
  const r = runGuardrails({
    title: "T",
    content: "Token aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5",
    type: "PATTERN",
    tags: ["t"],
  });
  assert.ok(r.sanitizedContent.includes("[HIGH_ENTROPY]") || r.sanitizedContent.includes("[API_KEY]"));
});

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);
