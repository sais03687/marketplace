#!/usr/bin/env node
/**
 * validate-agent — Creator CLI Validator
 *
 * Usage:
 *   npx @marketplace/validate-agent ./my-agent.zip
 *   node cli.mjs ./my-agent.zip
 *
 * Exit codes:
 *   0 — no errors (warnings may be present)
 *   1 — one or more errors found
 *   2 — usage error
 */

import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { validateManifest } from "@marketplace/agent-package-schema";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

const PASS  = `${C.green}✓${C.reset}`;
const WARN  = `${C.yellow}⚠${C.reset}`;
const ERROR = `${C.red}❌${C.reset}`;
const INFO  = `${C.cyan}ℹ${C.reset}`;

function label(tag, name) {
  const full = `${tag} ${name}`;
  const dots = ".".repeat(Math.max(2, 47 - full.length));
  return `  ${C.bold}${full}${C.reset} ${C.dim}${dots}${C.reset}`;
}

function printFindings(findings) {
  for (const f of findings) {
    if (f.level === "error")      console.log(`        ${ERROR}  ${f.msg}`);
    else if (f.level === "warn")  console.log(`        ${WARN}  ${f.msg}`);
    else                          console.log(`        ${INFO}  ${f.msg}`);
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_AUTONOMY_LEVELS = new Set([
  "always_queue",
  "queue_if_stakes_gt_5",
  "queue_if_stakes_gt_7",
  "auto_execute",
]);

const MIN_PRICE_CENTS = { haiku: 2900, sonnet: 5900, opus: 14900 };

const PLATFORM_TEMPLATE_VARS = new Set([
  "AGENT_NAME",
  "AGENT_EMAIL",
  "COMPANY_NAME",
  "COMPANY_DOMAIN",
  "MANAGER_EMAIL",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
]);

const DANGEROUS_PATTERNS_SERVER = [
  { re: /\bimport\s+subprocess\b/,      label: "import subprocess" },
  { re: /\bfrom\s+subprocess\b/,        label: "from subprocess" },
  { re: /\bos\.system\s*\(/,            label: "os.system()" },
  { re: /\bos\.popen\s*\(/,             label: "os.popen()" },
  { re: /\bos\.exec[vple]+\s*\(/,       label: "os.exec*()" },
  { re: /\bos\.spawn[vple]*\s*\(/,      label: "os.spawn*()" },
  { re: /(?<!\.)\beval\s*\(/,           label: "eval()" },
  { re: /\b__import__\s*\(/,            label: "dynamic __import__()" },
  { re: /\bimport\s+ctypes\b/,          label: "import ctypes" },
  { re: /\bfrom\s+ctypes\b/,            label: "from ctypes" },
  { re: /\bimport\s+pty\b/,             label: "import pty" },
  { re: /\bimport\s+pickle\b/,          label: "import pickle (unsafe deserialization)" },
  { re: /\bimport\s+marshal\b/,         label: "import marshal" },
];

const DANGEROUS_PATTERNS_EXTRA = [
  { re: /(?<!\.)\bexec\s*\(/,                          label: "exec() — same power as eval()" },
  { re: /(?<!\.)\bcompile\s*\(/,                       label: "compile() — creates code objects from strings" },
  { re: /\bimport\s+multiprocessing\b/,               label: "import multiprocessing (subprocess-equivalent)" },
  { re: /\bfrom\s+multiprocessing\b/,                 label: "from multiprocessing" },
  { re: /\bimport\s+socket\b|\bfrom\s+socket\b/,      label: "import socket (raw socket access)" },
];

const ALL_DANGEROUS = [...DANGEROUS_PATTERNS_SERVER, ...DANGEROUS_PATTERNS_EXTRA];

const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{48,}/,                          label: "OpenAI/OpenRouter key" },
  { re: /sk-ant-api\d{2}-[A-Za-z0-9_\-]{90,}/,         label: "Anthropic key" },
  { re: /AIza[0-9A-Za-z_\-]{35}/,                       label: "Google API key" },
  { re: /AKIA[0-9A-Z]{16}/,                             label: "AWS access key" },
  { re: /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/,     label: "Private key block" },
  { re: /sk_live_[0-9a-zA-Z]{24}/,                      label: "Stripe live key" },
  { re: /ghp_[A-Za-z0-9]{36}/,                          label: "GitHub PAT" },
  { re: /xoxb-\d{11}-\d{11}-[A-Za-z0-9]{24}/,          label: "Slack bot token" },
  { re: /[A-Za-z0-9+/]{40,}={0,2}(?=.*PRIVATE)/,       label: "Base64-encoded private key" },
];

const RESERVED_FILES_CUSTOM = ["adapter.py", "Dockerfile", "platform-requirements.txt"];
const SHADOWED_MODULES = [
  "fastapi.py", "uvicorn.py", "httpx.py", "pydantic.py",
  "json.py", "os.py", "sys.py", "subprocess.py", "socket.py",
  "asyncio.py", "pathlib.py", "importlib.py",
];

const APPROVAL_POLICY_OPTIONS = new Set(["always", "external-only", "risk-based", "never"]);

// ── Utility ───────────────────────────────────────────────────────────────────

function isBinary(buf) {
  for (let i = 0; i < Math.min(buf.length, 4096); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function redact(match) { return match.slice(0, 8) + "…"; }

function fmtBytes(n) {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const zipPath = process.argv[2];
if (!zipPath) {
  console.error(`Usage: npx @marketplace/validate-agent <path-to-agent.zip>`);
  process.exit(2);
}

let zipBuf;
try {
  zipBuf = readFileSync(zipPath);
} catch (e) {
  console.error(`Cannot read file: ${zipPath}\n${e.message}`);
  process.exit(2);
}

let zip;
try {
  zip = await JSZip.loadAsync(zipBuf);
} catch (e) {
  console.error(`${ERROR}  Cannot parse zip file: ${e.message}`);
  process.exit(1);
}

const totalBytes = zipBuf.length;
const zipName = zipPath.split(/[\\/]/).pop();
const entries = Object.entries(zip.files).filter(([, e]) => !e.dir);
const entryPaths = entries.map(([p]) => p);

// Parse manifest early to determine runtime
let manifest = null;
const manifestEntry = zip.file("marketplace.json");
if (manifestEntry) {
  try { manifest = JSON.parse(await manifestEntry.async("string")); } catch { /* handled in [B] */ }
}

const runtime  = manifest?.runtime  ?? "custom";
const modelTier = manifest?.modelTier ?? "haiku";
const version  = manifest?.version  ?? "?";
const isCustom = runtime === "custom";

console.log();
console.log(`  ${C.bold}Validating:${C.reset} ${zipName} (${fmtBytes(totalBytes)})`);
if (manifest) {
  console.log(`  ${C.dim}Runtime: ${runtime}  |  Model: ${modelTier}  |  Version: ${version}${C.reset}`);
}
console.log();

let totalErrors = 0;
let totalWarns  = 0;
function addErrors(n) { totalErrors += n; }
function addWarns(n)  { totalWarns  += n; }

// ── [A] ZIP Integrity ─────────────────────────────────────────────────────────
{
  const findings = [];
  const topLevels = new Set(entryPaths.map((p) => p.split("/")[0]));
  const hasTopWrapper =
    entryPaths.length > 0 && topLevels.size === 1 && entryPaths.every((p) => p.includes("/"));
  if (hasTopWrapper) {
    findings.push({ level: "error", msg: `All files are inside a directory wrapper "${[...topLevels][0]}/". Files must be at root.` });
  }
  if (totalBytes > 50 * 1024 * 1024) {
    findings.push({ level: "error", msg: `Package is ${fmtBytes(totalBytes)} — exceeds 50 MB hard limit (server will reject it).` });
  } else if (totalBytes > 10 * 1024 * 1024) {
    findings.push({ level: "warn", msg: `Package is ${fmtBytes(totalBytes)} — unusually large for an agent package (no model weights should be bundled).` });
  }
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);
  console.log(`${label("[A]", "ZIP Structure")} ${errs ? ERROR : warns ? WARN : PASS}`);
  printFindings(findings);
}

// ── [B] marketplace.json ──────────────────────────────────────────────────────
{
  const findings = [];
  if (!manifestEntry) {
    findings.push({ level: "error", msg: "marketplace.json not found at root." });
  } else if (!manifest) {
    findings.push({ level: "error", msg: "marketplace.json is not valid JSON." });
  } else {
    for (const e of validateManifest(manifest)) {
      findings.push({ level: "error", msg: `${e.field}: ${e.message}` });
    }
    if (typeof manifest.tagline === "string" && manifest.tagline.length > 100)
      findings.push({ level: "error", msg: `tagline is ${manifest.tagline.length} chars — max 100.` });
    if (typeof manifest.description === "string" && manifest.description.length > 2000)
      findings.push({ level: "error", msg: `description is ${manifest.description.length} chars — max 2000.` });
    if (typeof manifest.description === "string" && manifest.description.length < 100)
      findings.push({ level: "warn", msg: `description is only ${manifest.description.length} chars — a fuller description improves discoverability.` });
    if (typeof manifest.pricePerMonth === "number" && typeof manifest.modelTier === "string") {
      const min = MIN_PRICE_CENTS[manifest.modelTier.toLowerCase()];
      if (min !== undefined && manifest.pricePerMonth < min)
        findings.push({ level: "error", msg: `pricePerMonth ${manifest.pricePerMonth}¢ is below minimum ${min}¢ ($${(min/100).toFixed(0)}/mo) for ${manifest.modelTier} tier.` });
    }
    if (manifest.autonomyDefaults && typeof manifest.autonomyDefaults === "object") {
      for (const [k, v] of Object.entries(manifest.autonomyDefaults)) {
        if (!VALID_AUTONOMY_LEVELS.has(v))
          findings.push({ level: "error", msg: `autonomyDefaults.${k}: "${v}" is not a valid AutonomyLevel. Must be one of: ${[...VALID_AUTONOMY_LEVELS].join(", ")}.` });
      }
    }
    if (Array.isArray(manifest.capabilities) && manifest.capabilities.length === 1)
      findings.push({ level: "warn", msg: "Only 1 capability listed — a richer capabilities array improves marketplace listing." });
  }
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);
  console.log(`${label("[B]", "marketplace.json")} ${errs ? ERROR : warns ? WARN : PASS}`);
  printFindings(findings);
}

// ── [C] Runtime-Specific File Checks ─────────────────────────────────────────
if (!isCustom) {
  console.log(`${label("[C]", "File checks")} ${ERROR}`);
  console.log(`        ${C.dim}✗  runtime "${runtime}" is no longer supported — use "custom".${C.reset}`);
} else {
  const findings = [];
  if (!zip.file("agent.py"))
    findings.push({ level: "error", msg: "agent.py is required for custom runtime." });
  for (const f of RESERVED_FILES_CUSTOM)
    if (zip.file(f)) findings.push({ level: "error", msg: `"${f}" must not be included — platform-managed file.` });
  for (const f of SHADOWED_MODULES)
    if (zip.file(f)) findings.push({ level: "error", msg: `"${f}" shadows a system module.` });
  const agentPy = zip.file("agent.py");
  if (agentPy) {
    const src = await agentPy.async("string");
    if (!/^\s*(?:async\s+)?def\s+run_agent\s*\(/m.test(src)) {
      findings.push({ level: "error", msg: "run_agent function not found in agent.py." });
    } else {
      const sigMatch = src.match(/(?:async\s+)?def\s+run_agent\s*\(([^)]*)\)/);
      if (sigMatch) {
        const missing = ["content","context","approve_fn","resolve_fn","contribute_fn","search_fn"].filter((p) => !sigMatch[1].includes(p));
        if (missing.length) findings.push({ level: "warn", msg: `run_agent missing expected parameters: ${missing.join(", ")}.` });
        if (!/^\s*async\s+def\s+run_agent/m.test(src))
          findings.push({ level: "warn", msg: "run_agent is not async — will block the event loop." });
      }
    }
  }
  const reqEntry = zip.file("requirements.txt");
  if (!reqEntry) {
    findings.push({ level: "warn", msg: "requirements.txt missing — only platform-bundled packages will be available." });
  } else {
    const lines = (await reqEntry.async("string")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
    const unpinned = lines.filter((l) => !/[=<>!~]/.test(l));
    if (unpinned.length) findings.push({ level: "warn", msg: `${unpinned.length} unpinned requirement(s): ${unpinned.slice(0, 5).join(", ")}. Non-reproducible builds may break.` });
  }
  if (!zip.file("TOOLS.md"))
    findings.push({ level: "warn", msg: "TOOLS.md missing — strongly recommended to document tool routing." });
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);
  console.log(`${label("[C]", "File checks (custom)")} ${errs ? ERROR : warns ? WARN : PASS}`);
  printFindings(findings);
}

// ── [D] Dangerous Patterns (Custom only) ─────────────────────────────────────
if (!isCustom) {
  console.log(`${label("[D]", "Dangerous patterns")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
} else {
  const findings = [];
  for (const [path, entry] of entries) {
    if (!path.endsWith(".py")) continue;
    const lines = (await entry.async("string")).split("\n");
    for (const { re, label: patLabel } of ALL_DANGEROUS) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith("#")) continue;
        if (re.test(lines[i])) { findings.push({ level: "error", msg: `${path}:${i+1} — ${patLabel}` }); break; }
      }
    }
  }
  addErrors(findings.length);
  console.log(`${label("[D]", "Dangerous patterns")} ${findings.length ? ERROR : PASS}`);
  printFindings(findings);
  if (!findings.length)
    console.log(`        ${C.dim}ℹ  18 patterns checked. Obfuscated/dynamic patterns require manual review.${C.reset}`);
}

// ── [E] Secret Detection (Custom only) ───────────────────────────────────────
if (!isCustom) {
  console.log(`${label("[E]", "Secret detection")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
} else {
  const findings = [];
  for (const [path, entry] of entries) {
    const buf = await entry.async("uint8array");
    if (isBinary(buf)) continue;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    for (const { re, label: secLabel } of SECRET_PATTERNS) {
      const m = re.exec(text);
      if (m) findings.push({ level: "error", msg: `${path}: possible ${secLabel} — "${redact(m[0])}" (platform injects all credentials; secrets in packages are exposed in storage).` });
    }
  }
  addErrors(findings.length);
  console.log(`${label("[E]", "Secret detection")} ${findings.length ? ERROR : PASS}`);
  printFindings(findings);
}

// ── [F] Template Variables (Custom only) ─────────────────────────────────────
if (!isCustom) {
  console.log(`${label("[F]", "Template variables")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
} else {
  const findings = [];
  const VAR_RE = /\{\{([A-Z0-9_]+)\}\}/g;
  for (const filePath of ["SOUL.md","AGENTS.md","MEMORY_TEMPLATE.md","onboarding/MEMORY_TEMPLATE.md"]) {
    const entry = zip.file(filePath);
    if (!entry) continue;
    const text = await entry.async("string");
    const seen = new Set();
    let m;
    while ((m = VAR_RE.exec(text)) !== null) {
      if (!PLATFORM_TEMPLATE_VARS.has(m[1]) && !seen.has(m[1])) {
        seen.add(m[1]);
        findings.push({ level: "warn", msg: `${filePath}: {{${m[1]}}} is not a recognized platform variable — will remain as literal text. Recognized: ${[...PLATFORM_TEMPLATE_VARS].join(", ")}.` });
      }
    }
  }
  addWarns(findings.length);
  console.log(`${label("[F]", "Template variables")} ${findings.length ? WARN : PASS}`);
  printFindings(findings);
}

// ── [G] onboarding/questions.json ─────────────────────────────────────────────
{
  const findings = [];
  const qEntry = zip.file("onboarding/questions.json");
  if (qEntry) {
    let questions;
    try { questions = JSON.parse(await qEntry.async("string")); }
    catch (e) { findings.push({ level: "error", msg: `onboarding/questions.json invalid JSON: ${e.message}` }); }
    if (questions !== undefined) {
      if (!Array.isArray(questions)) {
        findings.push({ level: "error", msg: "onboarding/questions.json must be an array." });
      } else {
        const ids = new Set(); const orders = [];
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          for (const f of ["id","order","question","memoryKey","required"])
            if (!(f in q)) findings.push({ level: "error", msg: `questions[${i}]: missing "${f}".` });
          if (q.id) { if (ids.has(q.id)) findings.push({ level: "error", msg: `Duplicate id "${q.id}".` }); ids.add(q.id); }
          if (q.order !== undefined) orders.push(q.order);
          if (q.id === "approval_policy") {
            const opts = (q.options||[]).map((o) => typeof o==="string"?o:o?.value??"");
            const missing = [...APPROVAL_POLICY_OPTIONS].filter((v)=>!opts.includes(v));
            if (missing.length) findings.push({ level: "error", msg: `approval_policy options missing: ${missing.join(", ")}.` });
          }
          if (q.type==="choice" && (!Array.isArray(q.options)||q.options.length===0))
            findings.push({ level: "warn", msg: `questions[${i}] (id="${q.id}"): type "choice" missing options.` });
          if (q.memoryKey && !q.memoryKey.includes("."))
            findings.push({ level: "warn", msg: `questions[${i}] (id="${q.id}"): memoryKey "${q.memoryKey}" not in dot-path format.` });
        }
        const counts = {};
        for (const o of orders) counts[o] = (counts[o]||0)+1;
        const dups = Object.entries(counts).filter(([,c])=>c>1).map(([o])=>o);
        if (dups.length) findings.push({ level: "warn", msg: `Duplicate order values: ${dups.join(", ")}.` });
      }
    }
  }
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);
  console.log(`${label("[G]", "onboarding/questions.json")} ${qEntry ? (errs ? ERROR : warns ? WARN : PASS) : PASS}`);
  if (!qEntry) console.log(`        ${C.dim}ℹ  Not present — optional file.${C.reset}`);
  else printFindings(findings);
}

// ── [H] Return Contract (Custom only) ────────────────────────────────────────
if (!isCustom) {
  console.log(`${label("[H]", "Return contract")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
} else {
  const findings = [];
  const agentEntry = zip.file("agent.py");
  if (!agentEntry) {
    findings.push({ level: "error", msg: "agent.py missing — cannot check return contract." });
  } else {
    const src = await agentEntry.async("string");
    if (!/^\s*(?:async\s+)?def\s+run_agent\s*\(/m.test(src)) {
      findings.push({ level: "error", msg: "No run_agent function found." });
    } else {
      if (!/"action"|'action'/.test(src))
        findings.push({ level: "warn", msg: 'No "action" key detected. Adapter requires action: "send_email"|"reply_email"|"resolve_approval"|"none".' });
      const detected = ["send_email","reply_email","resolve_approval","none"].filter((v) => src.includes(`"${v}"`) || src.includes(`'${v}'`));
      if (detected.length) findings.push({ level: "info", msg: `Detected action values: ${detected.join(", ")}.` });
    }
  }
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);
  console.log(`${label("[H]", "Return contract")} ${errs ? ERROR : warns ? WARN : PASS}`);
  printFindings(findings);
}

// ── [I] Recommendations ───────────────────────────────────────────────────────
{
  const findings = [];
  if (isCustom) {
    if (!zip.file("onboarding/MEMORY_TEMPLATE.md"))
      findings.push({ level: "warn", msg: "onboarding/MEMORY_TEMPLATE.md missing — agent starts with blank memory." });
    if (!zip.file("TOOLS.md"))
      findings.push({ level: "warn", msg: "TOOLS.md missing — strongly recommended to document tool routing." });
  }
  if (!entryPaths.some((p) => p.startsWith("onboarding/")))
    findings.push({ level: "warn", msg: 'No "onboarding/" directory — onboarding files give buyers a personalised first-run experience.' });
  addWarns(findings.length);
  console.log(`${label("[I]", "Recommendations")} ${findings.length ? WARN : PASS}`);
  printFindings(findings);
}

// ── [J] tests/tests.json ──────────────────────────────────────────────────────
{
  const findings = [];
  const tEntry = zip.file("tests/tests.json");
  if (tEntry) {
    let tests;
    try { tests = JSON.parse(await tEntry.async("string")); }
    catch (e) { findings.push({ level: "error", msg: `tests/tests.json invalid JSON: ${e.message}` }); }
    if (tests !== undefined) {
      if (!Array.isArray(tests)) {
        findings.push({ level: "error", msg: "tests/tests.json must be an array." });
      } else {
        for (let i = 0; i < tests.length; i++) {
          const t = tests[i];
          for (const f of ["id","name","input","expectedBehavior"])
            if (!(f in t)) findings.push({ level: "error", msg: `tests[${i}]: missing "${f}".` });
          if (t.input?.channel && !["email","slack"].includes(t.input.channel))
            findings.push({ level: "error", msg: `tests[${i}]: channel must be "email" or "slack".` });
          if (t.expectedBehavior !== undefined) {
            if (typeof t.expectedBehavior !== "object" || t.expectedBehavior === null || Array.isArray(t.expectedBehavior)) {
              findings.push({ level: "error", msg: `tests[${i}]: expectedBehavior must be an object, got ${typeof t.expectedBehavior}.` });
            } else {
              if ("shouldQueue" in t.expectedBehavior && typeof t.expectedBehavior.shouldQueue !== "boolean")
                findings.push({ level: "error", msg: `tests[${i}]: shouldQueue must be boolean.` });
              if ("shouldClarify" in t.expectedBehavior && typeof t.expectedBehavior.shouldClarify !== "boolean")
                findings.push({ level: "error", msg: `tests[${i}]: shouldClarify must be boolean.` });
            }
          }
        }
      }
    }
  }
  const errs = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);
  console.log(`${label("[J]", "tests/tests.json")} ${tEntry ? (errs ? ERROR : warns ? WARN : PASS) : PASS}`);
  if (!tEntry) console.log(`        ${C.dim}ℹ  Not present — optional but recommended for vetting sandbox.${C.reset}`);
  else printFindings(findings);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log(`  ${C.dim}${"─".repeat(50)}${C.reset}`);
console.log(`  Summary: ${C.bold}${totalErrors} error${totalErrors !== 1 ? "s" : ""}${C.reset}, ${totalWarns} warning${totalWarns !== 1 ? "s" : ""}`);
console.log();

if (totalErrors > 0) {
  console.log(`  ${ERROR}  ${C.red}${C.bold}Fix errors before uploading.${C.reset}${totalWarns > 0 ? " Warnings are optional but recommended." : ""}`);
  console.log();
  process.exit(1);
} else if (totalWarns > 0) {
  console.log(`  ${WARN}  ${C.yellow}${C.bold}Ready to upload.${C.reset} Warnings are optional but recommended.`);
  console.log();
  process.exit(0);
} else {
  console.log(`  ${PASS}  ${C.green}${C.bold}All checks passed — ready to upload.${C.reset}`);
  console.log();
  process.exit(0);
}
