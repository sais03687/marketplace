#!/usr/bin/env node
/**
 * validate-agent.mjs — Creator CLI Validator
 *
 * Usage:
 *   node scripts/validate-agent.mjs ./my-agent.zip
 *
 * Exit codes:
 *   0 — no errors (warnings may be present)
 *   1 — one or more errors found
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// ── Dynamic imports (reuse existing monorepo node_modules) ────────────────────

const requireWeb = createRequire(
  resolve(rootDir, "apps/web/node_modules/.package-lock.json"),
);
let JSZip;
try {
  JSZip = requireWeb("jszip");
} catch {
  // fallback: try root node_modules
  const requireRoot = createRequire(
    resolve(rootDir, "node_modules/.package-lock.json"),
  );
  JSZip = requireRoot("jszip");
}

// Import validateManifest from compiled schema package
let validateManifest;
try {
  const schemaPath = resolve(rootDir, "packages/agent-package-schema/dist/validate.js");
  const schema = await import(pathToFileURL(schemaPath).href);
  validateManifest = schema.validateManifest;
} catch (e) {
  console.error("Could not load @marketplace/agent-package-schema/dist/validate.js:", e.message);
  process.exit(2);
}

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

// 13 patterns already in upload/route.ts
const DANGEROUS_PATTERNS_SERVER = [
  { re: /\bimport\s+subprocess\b/,      label: "import subprocess" },
  { re: /\bfrom\s+subprocess\b/,        label: "from subprocess" },
  { re: /\bos\.system\s*\(/,            label: "os.system()" },
  { re: /\bos\.popen\s*\(/,             label: "os.popen()" },
  { re: /\bos\.exec[vple]+\s*\(/,       label: "os.exec*()" },
  { re: /\bos\.spawn[vple]*\s*\(/,      label: "os.spawn*()" },
  { re: /(?<!\.)\beval\s*\(/,            label: "eval()" },
  { re: /\b__import__\s*\(/,            label: "dynamic __import__()" },
  { re: /\bimport\s+ctypes\b/,          label: "import ctypes" },
  { re: /\bfrom\s+ctypes\b/,            label: "from ctypes" },
  { re: /\bimport\s+pty\b/,             label: "import pty" },
  { re: /\bimport\s+pickle\b/,          label: "import pickle (unsafe deserialization)" },
  { re: /\bimport\s+marshal\b/,         label: "import marshal" },
];

// 5 additional patterns not yet in upload/route.ts
const DANGEROUS_PATTERNS_EXTRA = [
  { re: /(?<!\.)\bexec\s*\(/,                  label: "exec() — same power as eval()" },
  { re: /(?<!\.)\bcompile\s*\(/,               label: "compile() — creates code objects from strings" },
  { re: /\bimport\s+multiprocessing\b/, label: "import multiprocessing (subprocess-equivalent)" },
  { re: /\bfrom\s+multiprocessing\b/,   label: "from multiprocessing" },
  { re: /\bimport\s+socket\b|\bfrom\s+socket\b/, label: "import socket (raw socket access)" },
];

const ALL_DANGEROUS = [...DANGEROUS_PATTERNS_SERVER, ...DANGEROUS_PATTERNS_EXTRA];

// Platform-injected secrets — banned from packages
const SECRET_PATTERNS = [
  { re: /sk-[A-Za-z0-9]{48,}/,                           label: "OpenAI/OpenRouter key" },
  { re: /sk-ant-api\d{2}-[A-Za-z0-9_\-]{90,}/,          label: "Anthropic key" },
  { re: /AIza[0-9A-Za-z_\-]{35}/,                        label: "Google API key" },
  { re: /AKIA[0-9A-Z]{16}/,                              label: "AWS access key" },
  { re: /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/,      label: "Private key block" },
  { re: /sk_live_[0-9a-zA-Z]{24}/,                       label: "Stripe live key" },
  { re: /ghp_[A-Za-z0-9]{36}/,                           label: "GitHub PAT" },
  { re: /xoxb-\d{11}-\d{11}-[A-Za-z0-9]{24}/,           label: "Slack bot token" },
  { re: /[A-Za-z0-9+/]{40,}={0,2}(?=.*PRIVATE)/,        label: "Base64-encoded private key" },
];

const RESERVED_FILES_CUSTOM  = ["adapter.py", "Dockerfile", "platform-requirements.txt"];
const SHADOWED_MODULES        = [
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

function redact(match) {
  return match.slice(0, 8) + "…";
}

function fmtBytes(n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const zipPath = process.argv[2];
if (!zipPath) {
  console.error(`Usage: node scripts/validate-agent.mjs <path-to-agent.zip>`);
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

// Collect all non-dir entries
const entries = Object.entries(zip.files).filter(([, e]) => !e.dir);
const entryPaths = entries.map(([p]) => p);

// ── Determine runtime (need manifest for this) ────────────────────────────────

let manifest = null;
let manifestText = "";
const manifestEntry = zip.file("marketplace.json");
if (manifestEntry) {
  try {
    manifestText = await manifestEntry.async("string");
    manifest = JSON.parse(manifestText);
  } catch { /* handled in check B */ }
}

const runtime = manifest?.runtime ?? "openclaw";
const modelTier = manifest?.modelTier ?? "haiku";
const version = manifest?.version ?? "?";

console.log();
console.log(`  ${C.bold}Validating:${C.reset} ${zipName} (${fmtBytes(totalBytes)})`);
if (manifest) {
  console.log(`  ${C.dim}Runtime: ${runtime}  |  Model: ${modelTier}  |  Version: ${version}${C.reset}`);
}
console.log();

let totalErrors = 0;
let totalWarns = 0;

function addErrors(n) { totalErrors += n; }
function addWarns(n)  { totalWarns += n; }

// ── [A] ZIP Integrity ─────────────────────────────────────────────────────────

{
  const findings = [];

  // Check for top-level directory wrapper
  // A wrapped zip has ALL entries starting with "dirname/"
  const topLevels = new Set(entryPaths.map((p) => p.split("/")[0]));
  const hasTopWrapper =
    entryPaths.length > 0 &&
    topLevels.size === 1 &&
    entryPaths.every((p) => p.includes("/"));
  if (hasTopWrapper) {
    findings.push({
      level: "error",
      msg: `All files are inside a directory wrapper "${[...topLevels][0]}/". Files must be at root (not "my-agent/marketplace.json").`,
    });
  }

  if (totalBytes > 50 * 1024 * 1024) {
    findings.push({ level: "error", msg: `Package is ${fmtBytes(totalBytes)} — exceeds 50 MB hard limit (server will reject it).` });
  } else if (totalBytes > 10 * 1024 * 1024) {
    findings.push({ level: "warn", msg: `Package is ${fmtBytes(totalBytes)} — unusually large for an agent package (no model weights should be bundled).` });
  }

  const errs  = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);

  const status = errs ? ERROR : warns ? WARN : PASS;
  console.log(`${label("[A]", "ZIP Structure")} ${status}`);
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
    // Run the authoritative server validator (zero drift from server)
    const schemaErrors = validateManifest(manifest);
    for (const e of schemaErrors) {
      findings.push({ level: "error", msg: `${e.field}: ${e.message}` });
    }

    // Extra checks not in validateManifest()
    if (typeof manifest.tagline === "string" && manifest.tagline.length > 100) {
      findings.push({ level: "error", msg: `tagline is ${manifest.tagline.length} chars — max 100.` });
    }
    if (typeof manifest.description === "string" && manifest.description.length > 2000) {
      findings.push({ level: "error", msg: `description is ${manifest.description.length} chars — max 2000.` });
    }
    if (typeof manifest.description === "string" && manifest.description.length < 100) {
      findings.push({ level: "warn", msg: `description is only ${manifest.description.length} chars — a fuller description improves discoverability.` });
    }

    // Price vs tier minimums
    if (typeof manifest.pricePerMonth === "number" && typeof manifest.modelTier === "string") {
      const min = MIN_PRICE_CENTS[manifest.modelTier.toLowerCase()];
      if (min !== undefined && manifest.pricePerMonth < min) {
        findings.push({
          level: "error",
          msg: `pricePerMonth ${manifest.pricePerMonth}¢ is below the minimum ${min}¢ ($${(min / 100).toFixed(0)}/mo) for ${manifest.modelTier} tier.`,
        });
      }
    }

    // autonomyDefaults values
    if (manifest.autonomyDefaults && typeof manifest.autonomyDefaults === "object") {
      for (const [k, v] of Object.entries(manifest.autonomyDefaults)) {
        if (!VALID_AUTONOMY_LEVELS.has(v)) {
          findings.push({
            level: "error",
            msg: `autonomyDefaults.${k}: "${v}" is not a valid AutonomyLevel. Must be one of: ${[...VALID_AUTONOMY_LEVELS].join(", ")}.`,
          });
        }
      }
    }

    // Capability count warn
    if (Array.isArray(manifest.capabilities) && manifest.capabilities.length === 1) {
      findings.push({ level: "warn", msg: "Only 1 capability listed — a richer capabilities array improves marketplace listing." });
    }
  }

  const errs  = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);

  const status = errs ? ERROR : warns ? WARN : PASS;
  console.log(`${label("[B]", "marketplace.json")} ${status}`);
  printFindings(findings);
}

// ── [C] Runtime-Specific File Checks ─────────────────────────────────────────

const isCustom = runtime === "custom";

{
  if (!isCustom) {
    // OpenClaw and other runtimes — runtime-specific file checks are coming soon.
    // Manifest was already validated in [B]. Skip code-level checks for now.
    console.log(`${label("[C]", "File checks")} ${PASS}`);
    console.log(`        ${C.dim}ℹ  OpenClaw runtime-specific file checks coming soon.${C.reset}`);
  } else {
    const findings = [];

    // Required
    if (!zip.file("agent.py")) {
      findings.push({ level: "error", msg: "agent.py is required for custom runtime." });
    }

    // Reserved platform-managed files
    for (const f of RESERVED_FILES_CUSTOM) {
      if (zip.file(f)) {
        findings.push({ level: "error", msg: `"${f}" must not be included — this is a platform-managed file.` });
      }
    }

    // Shadowed system modules
    for (const f of SHADOWED_MODULES) {
      if (zip.file(f)) {
        findings.push({ level: "error", msg: `"${f}" shadows a system module and will break the adapter's imports.` });
      }
    }

    // run_agent callable
    const agentPy = zip.file("agent.py");
    if (agentPy) {
      const src = await agentPy.async("string");

      const hasRunAgent = /^\s*(?:async\s+)?def\s+run_agent\s*\(/m.test(src);
      if (!hasRunAgent) {
        findings.push({ level: "error", msg: "run_agent function not found in agent.py. The adapter calls run_agent() — it must be defined." });
      } else {
        const sigMatch = src.match(/(?:async\s+)?def\s+run_agent\s*\(([^)]*)\)/);
        if (sigMatch) {
          const sigStr = sigMatch[1];
          const EXPECTED_PARAMS = ["content", "context", "approve_fn", "resolve_fn", "contribute_fn", "search_fn"];
          const missing = EXPECTED_PARAMS.filter((p) => !sigStr.includes(p));
          if (missing.length > 0) {
            findings.push({ level: "warn", msg: `run_agent signature is missing expected parameters: ${missing.join(", ")}. The adapter passes these — missing params won't receive platform data.` });
          }
          const isAsync = /^\s*async\s+def\s+run_agent/m.test(src);
          if (!isAsync) {
            findings.push({ level: "warn", msg: "run_agent is not async. It will block the event loop while running — highly recommended to use async def." });
          }
        }
      }
    }

    // requirements.txt
    const reqEntry = zip.file("requirements.txt");
    if (!reqEntry) {
      findings.push({ level: "warn", msg: "requirements.txt missing — only platform-bundled packages (langchain, langgraph, httpx, etc.) will be available." });
    } else {
      const reqText = await reqEntry.async("string");
      const reqLines = reqText.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
      const unpinned = reqLines.filter((l) => !/[=<>!~]/.test(l));
      if (unpinned.length > 0) {
        findings.push({ level: "warn", msg: `${unpinned.length} unpinned requirement(s) in requirements.txt: ${unpinned.slice(0, 5).join(", ")}${unpinned.length > 5 ? "…" : ""}. Non-reproducible builds may fail after upstream releases.` });
      }
    }

    if (!zip.file("TOOLS.md")) {
      findings.push({ level: "warn", msg: "TOOLS.md missing — strongly recommended to document tool routing and decision framework for the agent." });
    }

    const errs  = findings.filter((f) => f.level === "error").length;
    const warns = findings.filter((f) => f.level === "warn").length;
    addErrors(errs); addWarns(warns);

    const status = errs ? ERROR : warns ? WARN : PASS;
    console.log(`${label("[C]", "File checks (custom)")} ${status}`);
    printFindings(findings);
  }
}

// ── [D] Dangerous Code Patterns (Custom only) ────────────────────────────────

if (!isCustom) {
  console.log(`${label("[D]", "Dangerous patterns")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
} else {
  const findings = [];

  for (const [path, entry] of entries) {
    if (!path.endsWith(".py")) continue;
    const src = await entry.async("string");
    const lines = src.split("\n");

    for (const { re, label: patLabel } of ALL_DANGEROUS) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trimStart().startsWith("#")) continue;
        if (re.test(line)) {
          findings.push({
            level: "error",
            msg: `${path}:${i + 1} — ${patLabel}`,
          });
          break; // one finding per pattern per file
        }
      }
    }
  }

  addErrors(findings.length);
  const status = findings.length ? ERROR : PASS;
  console.log(`${label("[D]", "Dangerous patterns")} ${status}`);
  printFindings(findings);
  if (!findings.length) {
    console.log(`        ${C.dim}ℹ  18 patterns checked (13 server + 5 additional). Obfuscated/dynamic patterns require manual review.${C.reset}`);
  }
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
      if (m) {
        findings.push({
          level: "error",
          msg: `${path}: possible ${secLabel} — "${redact(m[0])}" (platform injects all credentials at deployment time; embedding them here exposes them in Vercel Blob storage).`,
        });
      }
    }
  }

  addErrors(findings.length);
  const status = findings.length ? ERROR : PASS;
  console.log(`${label("[E]", "Secret detection")} ${status}`);
  printFindings(findings);
}

// ── [F] Template Variables (Custom only) ─────────────────────────────────────

if (!isCustom) {
  console.log(`${label("[F]", "Template variables")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
} else {
  const findings = [];
  const TEMPLATE_FILES = ["SOUL.md", "AGENTS.md", "MEMORY_TEMPLATE.md", "onboarding/MEMORY_TEMPLATE.md"];
  const VAR_RE = /\{\{([A-Z0-9_]+)\}\}/g;

  for (const filePath of TEMPLATE_FILES) {
    const entry = zip.file(filePath);
    if (!entry) continue;
    const text = await entry.async("string");
    let m;
    const seen = new Set();
    while ((m = VAR_RE.exec(text)) !== null) {
      const varName = m[1];
      if (!PLATFORM_TEMPLATE_VARS.has(varName) && !seen.has(varName)) {
        seen.add(varName);
        findings.push({
          level: "warn",
          msg: `${filePath}: {{${varName}}} is not a recognized platform template variable — it will remain as literal text in the deployed agent. Recognized vars: ${[...PLATFORM_TEMPLATE_VARS].join(", ")}.`,
        });
      }
    }
  }

  const warns = findings.filter((f) => f.level === "warn").length;
  addWarns(warns);
  const status = warns ? WARN : PASS;
  console.log(`${label("[F]", "Template variables")} ${status}`);
  printFindings(findings);
}

// ── [G] onboarding/questions.json ─────────────────────────────────────────────

{
  const findings = [];
  const qEntry = zip.file("onboarding/questions.json");

  if (qEntry) {
    let questions;
    try {
      const text = await qEntry.async("string");
      questions = JSON.parse(text);
    } catch (e) {
      findings.push({ level: "error", msg: `onboarding/questions.json is not valid JSON: ${e.message}` });
    }

    if (questions !== undefined) {
      if (!Array.isArray(questions)) {
        findings.push({ level: "error", msg: "onboarding/questions.json must be an array." });
      } else {
        const ids = new Set();
        const orders = [];

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const REQUIRED_FIELDS = ["id", "order", "question", "memoryKey", "required"];
          for (const f of REQUIRED_FIELDS) {
            if (!(f in q)) {
              findings.push({ level: "error", msg: `questions[${i}]: missing required field "${f}".` });
            }
          }

          if (q.id) {
            if (ids.has(q.id)) {
              findings.push({ level: "error", msg: `Duplicate question id "${q.id}".` });
            }
            ids.add(q.id);
          }

          if (q.order !== undefined) orders.push(q.order);

          // approval_policy check
          if (q.id === "approval_policy") {
            const opts = (q.options || []).map((o) => (typeof o === "string" ? o : o?.value ?? ""));
            const missing = [...APPROVAL_POLICY_OPTIONS].filter((v) => !opts.includes(v));
            if (missing.length > 0) {
              findings.push({
                level: "error",
                msg: `approval_policy question options missing required values: ${missing.join(", ")}. All four must be present: ${[...APPROVAL_POLICY_OPTIONS].join(", ")}.`,
              });
            }
          }

          // choice without options
          if (q.type === "choice" && (!Array.isArray(q.options) || q.options.length === 0)) {
            findings.push({ level: "warn", msg: `questions[${i}] (id="${q.id}"): type is "choice" but has no options array.` });
          }

          // memoryKey dot-path format
          if (q.memoryKey && typeof q.memoryKey === "string" && !q.memoryKey.includes(".")) {
            findings.push({ level: "warn", msg: `questions[${i}] (id="${q.id}"): memoryKey "${q.memoryKey}" is not in dot-path format (e.g. "org.approvalPolicy"). Consider scoping it.` });
          }
        }

        // duplicate order values
        const orderCounts = {};
        for (const o of orders) {
          orderCounts[o] = (orderCounts[o] || 0) + 1;
        }
        const dupOrders = Object.entries(orderCounts).filter(([, c]) => c > 1).map(([o]) => o);
        if (dupOrders.length > 0) {
          findings.push({ level: "warn", msg: `Duplicate order values: ${dupOrders.join(", ")}. Questions will render in undefined order.` });
        }
      }
    }
  }

  const errs  = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);

  const status = errs ? ERROR : warns ? WARN : PASS;
  const entryLabel = qEntry ? "onboarding/questions.json" : "onboarding/questions.json";
  console.log(`${label("[G]", entryLabel)} ${qEntry ? status : PASS}`);
  if (!qEntry) {
    console.log(`        ${C.dim}ℹ  Not present — optional file.${C.reset}`);
  } else {
    printFindings(findings);
  }
}

// ── [H] Return Contract Pre-Check (Custom only) ───────────────────────────────

{
  if (isCustom) {
    const findings = [];
    const agentEntry = zip.file("agent.py");

    if (!agentEntry) {
      // Already reported in [C]
      findings.push({ level: "error", msg: "agent.py missing — cannot perform return contract check." });
    } else {
      const src = await agentEntry.async("string");

      // run_agent must exist (already checked in [C], but repeat for this section's clarity)
      const hasRunAgent = /^\s*(?:async\s+)?def\s+run_agent\s*\(/m.test(src);
      if (!hasRunAgent) {
        findings.push({ level: "error", msg: 'No run_agent function definition found in agent.py.' });
      } else {
        // Heuristic: does the file return an "action" key?
        const hasActionKey = /["']action["']/.test(src);
        if (!hasActionKey) {
          findings.push({
            level: "warn",
            msg: 'No "action" key detected in agent.py. The adapter requires the return dict to include "action": "send_email"|"reply_email"|"resolve_approval"|"none". If it is absent the adapter will default to "none".',
          });
        }

        // Info: detected action values
        const ACTION_VALUES = ["send_email", "reply_email", "resolve_approval", "none"];
        const detected = ACTION_VALUES.filter((v) => src.includes(`"${v}"`) || src.includes(`'${v}'`));
        if (detected.length > 0) {
          findings.push({ level: "info", msg: `Detected action values used: ${detected.join(", ")}.` });
        }
      }
    }

    const errs  = findings.filter((f) => f.level === "error").length;
    const warns = findings.filter((f) => f.level === "warn").length;
    addErrors(errs); addWarns(warns);

    const status = errs ? ERROR : warns ? WARN : PASS;
    console.log(`${label("[H]", "Return contract")} ${status}`);
    printFindings(findings);
  } else {
    console.log(`${label("[H]", "Return contract")} ${C.dim}SKIP (non-custom runtime)${C.reset}`);
  }
}

// ── [I] Structural Recommendations ───────────────────────────────────────────

{
  const findings = [];

  if (isCustom) {
    if (!zip.file("onboarding/MEMORY_TEMPLATE.md")) {
      findings.push({ level: "warn", msg: "onboarding/MEMORY_TEMPLATE.md missing — agent starts with blank memory. Providing a template pre-populates context at deployment time." });
    }
    if (!zip.file("TOOLS.md")) {
      findings.push({ level: "warn", msg: "TOOLS.md missing — strongly recommended to document the agent's tool routing, risk levels, and decision framework." });
    }
  }

  if (!zip.file("onboarding") && !entryPaths.some((p) => p.startsWith("onboarding/"))) {
    findings.push({ level: "warn", msg: 'No "onboarding/" directory present — onboarding/questions.json and onboarding/MEMORY_TEMPLATE.md give buyers a personalised first-run experience.' });
  }

  const warns = findings.filter((f) => f.level === "warn").length;
  addWarns(warns);
  const status = warns ? WARN : PASS;
  console.log(`${label("[I]", "Recommendations")} ${status}`);
  printFindings(findings);
}

// ── [J] tests/tests.json ──────────────────────────────────────────────────────

{
  const findings = [];
  const tEntry = zip.file("tests/tests.json");

  if (tEntry) {
    let tests;
    try {
      const text = await tEntry.async("string");
      tests = JSON.parse(text);
    } catch (e) {
      findings.push({ level: "error", msg: `tests/tests.json is not valid JSON: ${e.message}` });
    }

    if (tests !== undefined) {
      if (!Array.isArray(tests)) {
        findings.push({ level: "error", msg: "tests/tests.json must be an array." });
      } else {
        for (let i = 0; i < tests.length; i++) {
          const t = tests[i];
          for (const f of ["id", "name", "input", "expectedBehavior"]) {
            if (!(f in t)) {
              findings.push({ level: "error", msg: `tests[${i}]: missing required field "${f}".` });
            }
          }
          if (t.input?.channel !== undefined && !["email", "slack"].includes(t.input.channel)) {
            findings.push({ level: "error", msg: `tests[${i}] (id="${t.id}"): input.channel must be "email" or "slack", got "${t.input.channel}".` });
          }
          if (t.expectedBehavior !== undefined) {
            if (typeof t.expectedBehavior !== "object" || t.expectedBehavior === null || Array.isArray(t.expectedBehavior)) {
              findings.push({ level: "error", msg: `tests[${i}] (id="${t.id}"): expectedBehavior must be an object, got ${typeof t.expectedBehavior}.` });
            } else {
              if ("shouldQueue" in t.expectedBehavior && typeof t.expectedBehavior.shouldQueue !== "boolean") {
                findings.push({ level: "error", msg: `tests[${i}] (id="${t.id}"): expectedBehavior.shouldQueue must be a boolean.` });
              }
              if ("shouldClarify" in t.expectedBehavior && typeof t.expectedBehavior.shouldClarify !== "boolean") {
                findings.push({ level: "error", msg: `tests[${i}] (id="${t.id}"): expectedBehavior.shouldClarify must be a boolean.` });
              }
            }
          }
        }
      }
    }
  }

  const errs  = findings.filter((f) => f.level === "error").length;
  const warns = findings.filter((f) => f.level === "warn").length;
  addErrors(errs); addWarns(warns);

  const status = errs ? ERROR : warns ? WARN : PASS;
  console.log(`${label("[J]", "tests/tests.json")} ${tEntry ? status : PASS}`);
  if (!tEntry) {
    console.log(`        ${C.dim}ℹ  Not present — optional but recommended for vetting sandbox.${C.reset}`);
  } else {
    printFindings(findings);
  }
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
