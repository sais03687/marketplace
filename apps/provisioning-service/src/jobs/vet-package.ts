/**
 * vet-package.ts — Automated vetting sandbox job
 *
 * Triggered via BullMQ when an admin clicks "Run Sandbox" on a pending package.
 * Downloads the package from Vercel Blob, runs static checks + Docker bootability
 * tests, and writes results to AgentVersion.vetNotes + AgentVersion.testResults.
 *
 * Does NOT change vetStatus to PASSED/FAILED — the admin still makes the final
 * decision. This is a pre-review aid, not an auto-approver.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import Dockerode from "dockerode";
import { prisma } from "@marketplace/db";
import { validateManifest } from "@marketplace/agent-package-schema";
import { isBlobStoragePath, downloadBlobPackage } from "../utils/blob-download.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CustomTest } from "../queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docker = new Dockerode();

// ── Static check patterns (mirrors validate-agent.mjs) ───────────────────────

const DANGEROUS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bimport\s+subprocess\b/,           label: "import subprocess" },
  { re: /\bfrom\s+subprocess\b/,             label: "from subprocess" },
  { re: /\bos\.system\s*\(/,                 label: "os.system()" },
  { re: /\bos\.popen\s*\(/,                  label: "os.popen()" },
  { re: /\bos\.exec[vple]+\s*\(/,            label: "os.exec*()" },
  { re: /\bos\.spawn[vple]*\s*\(/,           label: "os.spawn*()" },
  { re: /(?<!\.)\beval\s*\(/,                label: "eval()" },
  { re: /\b__import__\s*\(/,                 label: "__import__()" },
  { re: /\bimport\s+ctypes\b/,               label: "import ctypes" },
  { re: /\bfrom\s+ctypes\b/,                 label: "from ctypes" },
  { re: /\bimport\s+pty\b/,                  label: "import pty" },
  { re: /\bimport\s+pickle\b/,               label: "import pickle" },
  { re: /\bimport\s+marshal\b/,              label: "import marshal" },
  { re: /(?<!\.)\bexec\s*\(/,               label: "exec()" },
  { re: /(?<!\.)\bcompile\s*\(/,            label: "compile()" },
  { re: /\bimport\s+multiprocessing\b/,     label: "import multiprocessing" },
  { re: /\bfrom\s+multiprocessing\b/,       label: "from multiprocessing" },
  { re: /\bimport\s+socket\b|\bfrom\s+socket\b/, label: "import socket" },
];

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9]{48,}/,                        label: "OpenAI/OpenRouter key" },
  { re: /sk-ant-api\d{2}-[A-Za-z0-9_\-]{90,}/,       label: "Anthropic key" },
  { re: /AIza[0-9A-Za-z_\-]{35}/,                     label: "Google API key" },
  { re: /AKIA[0-9A-Z]{16}/,                           label: "AWS access key" },
  { re: /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/,   label: "Private key block" },
  { re: /sk_live_[0-9a-zA-Z]{24}/,                    label: "Stripe live key" },
  { re: /ghp_[A-Za-z0-9]{36}/,                        label: "GitHub PAT" },
  { re: /xoxb-\d{11}-\d{11}-[A-Za-z0-9]{24}/,        label: "Slack bot token" },
];

const RESERVED_FILES = ["adapter.py", "Dockerfile", "platform-requirements.txt"];
const SHADOWED_MODULES = [
  "fastapi.py", "uvicorn.py", "httpx.py", "pydantic.py",
  "json.py", "os.py", "sys.py", "subprocess.py", "socket.py",
  "asyncio.py", "pathlib.py", "importlib.py",
];

const APPROVAL_BLOCK = `## Approval queue — platform requirement

Before executing any action that:
- Sends an email to an external address
- Takes any irreversible action

You must call the approval queue and wait for resolution before proceeding.

`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface StepResult {
  name: string;
  status: "pass" | "fail" | "skip" | "warn";
  detail: string;
  findings?: string[];
}

interface VetReport {
  runAt: string;
  slug: string;
  version: string;
  runtime: string;
  steps: StepResult[];
  overallStatus: "pass" | "fail";
  summary: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBinary(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 4096); i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function elapsed(startMs: number): string {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

// ── Main job ──────────────────────────────────────────────────────────────────

interface VetJobOptions {
  customTests?: CustomTest[];
  skipDefaultTests?: boolean;
}

export async function vetPackageJob(versionId: string, opts: VetJobOptions = {}): Promise<void> {
  const { customTests = [], skipDefaultTests = false } = opts;
  console.log(`[vet-package] Starting vetting for version ${versionId}`);

  const agentVersion = await prisma.agentVersion.findUnique({
    where: { id: versionId },
    include: { agent: { select: { slug: true, name: true, runtime: true } } },
  });

  if (!agentVersion) {
    throw new Error(`AgentVersion ${versionId} not found`);
  }

  const { agent, storagePath, version, manifestData } = agentVersion;
  const manifest = manifestData as Record<string, unknown> | null;
  const runtime = (manifest?.runtime as string | undefined) ?? agent.runtime.toLowerCase();
  const slug = agent.slug;

  const report: VetReport = {
    runAt: new Date().toISOString(),
    slug,
    version,
    runtime,
    steps: [],
    overallStatus: "pass",
    summary: "",
  };

  // Mark as running
  await prisma.agentVersion.update({
    where: { id: versionId },
    data: {
      vetNotes: "Vetting sandbox running...",
      testResults: { status: "running", startedAt: report.runAt } as any,
    },
  });

  let packageDir: string | null = null;
  let buildDir: string | null = null;
  let imageName: string | null = null;
  let container: Dockerode.Container | null = null;

  try {
    // ── Step 1: Download package ──────────────────────────────────────────────
    {
      const t = Date.now();
      try {
        if (!storagePath) throw new Error("No storagePath on this AgentVersion — package may not have been uploaded correctly.");
        if (isBlobStoragePath(storagePath)) {
          packageDir = await downloadBlobPackage(storagePath);
        } else {
          packageDir = resolve(storagePath);
        }
        report.steps.push({ name: "Download package", status: "pass", detail: elapsed(t) });
      } catch (e: any) {
        report.steps.push({ name: "Download package", status: "fail", detail: e.message });
        report.overallStatus = "fail";
        throw e; // unrecoverable
      }
    }

    // ── Step 2: Static validation ─────────────────────────────────────────────
    {
      const findings: string[] = [];

      // Manifest
      const manifestErrors = validateManifest(manifest ?? {});
      for (const e of manifestErrors) findings.push(`manifest: ${e.field}: ${e.message}`);

      if (runtime === "custom") {
        // Required files
        if (!existsSync(join(packageDir!, "agent.py"))) findings.push("agent.py missing");
        for (const f of RESERVED_FILES)
          if (existsSync(join(packageDir!, f))) findings.push(`Reserved file present: ${f}`);
        for (const f of SHADOWED_MODULES)
          if (existsSync(join(packageDir!, f))) findings.push(`Shadowed module: ${f}`);

        // Dangerous patterns
        const pyFiles = findPyFiles(packageDir!);
        for (const pyPath of pyFiles) {
          const src = readFileSync(pyPath, "utf-8");
          const lines = src.split("\n");
          for (const { re, label } of DANGEROUS_PATTERNS) {
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].trimStart().startsWith("#")) continue;
              if (re.test(lines[i])) {
                findings.push(`dangerous: ${pyPath.replace(packageDir!, "")}:${i+1} — ${label}`);
                break;
              }
            }
          }
        }

        // Secret detection
        for (const pyPath of pyFiles) {
          const buf = readFileSync(pyPath);
          if (isBinary(buf)) continue;
          const text = buf.toString("utf-8");
          for (const { re, label } of SECRET_PATTERNS) {
            if (re.test(text)) findings.push(`secret: ${pyPath.replace(packageDir!, "")} — possible ${label}`);
          }
        }
      }

      report.steps.push({
        name: "Static validation",
        status: findings.length > 0 ? "fail" : "pass",
        detail: findings.length > 0 ? `${findings.length} issue(s) found` : "clean",
        findings,
      });
      if (findings.length > 0) report.overallStatus = "fail";
    }

    // ── Steps 3–5 only for custom runtime ─────────────────────────────────────
    if (runtime !== "custom") {
      report.steps.push({ name: "Docker build", status: "skip", detail: "non-custom runtime" });
      report.steps.push({ name: "Health check", status: "skip", detail: "non-custom runtime" });
      report.steps.push({ name: "HTTP tests", status: "skip", detail: "non-custom runtime" });
    } else {
      // ── Step 3: Docker build ─────────────────────────────────────────────────
      {
        const t = Date.now();
        try {
          buildDir = assembleBuildContext(packageDir!, slug);
          imageName = `marketplace/vet-${slug}:${version}`;

          let buildError: string | null = null;
          const stream = await docker.buildImage(
            { context: buildDir, src: ["."] },
            { t: imageName, dockerfile: "Dockerfile" },
          );

          await new Promise<void>((res, rej) => {
            docker.modem.followProgress(
              stream,
              (err: Error | null) => { if (err) rej(err); else res(); },
              (event: { stream?: string; error?: string }) => {
                if (event.error) buildError = event.error;
              },
            );
          });

          if (buildError) throw new Error(buildError);
          report.steps.push({ name: "Docker build", status: "pass", detail: elapsed(t) });
        } catch (e: any) {
          report.steps.push({ name: "Docker build", status: "fail", detail: e.message.slice(0, 200) });
          report.overallStatus = "fail";
          report.steps.push({ name: "Health check", status: "skip", detail: "build failed" });
          report.steps.push({ name: "HTTP tests", status: "skip", detail: "build failed" });
          // Skip to cleanup — no container to test
          throw new VetBuildError("Build failed — skipping runtime tests");
        }
      }

      // ── Step 4: Start container + health check ───────────────────────────────
      let hostPort = 0;
      {
        const t = Date.now();
        try {
          const containerName = `vet-${randomBytes(4).toString("hex")}`;
          const envVars = [
            `DEPLOYMENT_ID=vet-${randomBytes(4).toString("hex")}`,
            `AGENT_EMAIL=test@vet.internal`,
            `AGENT_NAME=VetAgent`,
            `COMPANY_NAME=VetCo`,
            `COMPANY_DOMAIN=vet.internal`,
            `MANAGER_EMAIL=manager@vet.internal`,
            `APPROVAL_POLICY=always`,
            `MODEL=haiku`,
            `LLM_API_KEY=vet-noop`,
            `LLM_BASE_URL=`,
            `LLM_MODEL=gpt-4o-mini`,
            `AGENTMAIL_API_KEY=vet-noop`,
            `ANTHROPIC_API_KEY=vet-noop`,
            `APPROVAL_WEBHOOK_TOKEN=vet-noop`,
            `MARKETPLACE_APPROVAL_WEBHOOK=http://host.docker.internal:3002`,
            `MARKETPLACE_URL=http://host.docker.internal:3002`,
            `PORTAL_TOKEN=vet-noop`,
            `GOOGLE_SERVICE_ACCOUNT_EMAIL=`,
            `GOOGLE_SERVICE_ACCOUNT_KEY=`,
            `PORT=4000`,
          ];

          container = await docker.createContainer({
            Image: imageName!,
            name: containerName,
            Env: envVars,
            ExposedPorts: { "4000/tcp": {} },
            HostConfig: {
              PortBindings: { "4000/tcp": [{ HostPort: "0" }] },
              Memory: 512 * 1024 * 1024,
              MemorySwap: 512 * 1024 * 1024,
              NanoCpus: 1_000_000_000,
              PidsLimit: 256,
              SecurityOpt: ["no-new-privileges"],
            },
          });
          await container.start();

          const info = await container.inspect();
          const bindings = info.NetworkSettings.Ports["4000/tcp"];
          if (!bindings || bindings.length === 0) throw new Error("No port binding");
          hostPort = parseInt(bindings[0].HostPort, 10);

          // Poll health up to 60s
          const deadline = Date.now() + 60_000;
          let healthy = false;
          while (Date.now() < deadline) {
            try {
              const res = await fetch(`http://127.0.0.1:${hostPort}/internal/health`, { signal: AbortSignal.timeout(3000) });
              if (res.ok) { const b = await res.json().catch(() => null); if (b?.ok) { healthy = true; break; } }
            } catch { /* not yet */ }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (!healthy) throw new Error("Container did not become healthy within 60s");

          report.steps.push({ name: "Health check", status: "pass", detail: `started in ${elapsed(t)}` });
        } catch (e: any) {
          report.steps.push({ name: "Health check", status: "fail", detail: e.message.slice(0, 200) });
          report.overallStatus = "fail";
          report.steps.push({ name: "HTTP tests", status: "skip", detail: "container not healthy" });
          throw new VetBuildError("Container unhealthy — skipping HTTP tests");
        }
      }

      // ── Step 5: HTTP tests ───────────────────────────────────────────────────
      {
        const base = `http://127.0.0.1:${hostPort}`;
        const testResults: { name: string; passed: boolean; error?: string }[] = [];

        // Built-in platform tests (skippable via skipDefaultTests)
        type HttpTest = { name: string; run: () => Promise<void> };
        const builtInTests: HttpTest[] = [
          {
            name: "GET /internal/health",
            run: async () => {
              const r = await fetch(`${base}/internal/health`, { signal: AbortSignal.timeout(5000) });
              const b = await r.json();
              if (!r.ok || b?.ok !== true) throw new Error(`Expected {ok:true}, got ${JSON.stringify(b)}`);
            },
          },
          {
            name: "GET /internal/memory",
            run: async () => {
              const r = await fetch(`${base}/internal/memory`, { signal: AbortSignal.timeout(5000) });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const b = await r.json();
              if (typeof b?.memory === "undefined") throw new Error("Missing 'memory' key");
            },
          },
          {
            name: "GET /internal/skills",
            run: async () => {
              const r = await fetch(`${base}/internal/skills`, { signal: AbortSignal.timeout(5000) });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const b = await r.json();
              if (!Array.isArray(b?.skills)) throw new Error("Missing 'skills' array");
            },
          },
          {
            name: "POST /hooks/agent (onboarding hook)",
            run: async () => {
              const r = await fetch(`${base}/hooks/agent`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "Hello, please introduce yourself.", name: "hook:onboarding", sessionKey: "hook:onboarding" }),
                signal: AbortSignal.timeout(15_000),
              });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
            },
          },
          {
            name: "POST /hooks/agentmail (synthetic email)",
            run: async () => {
              const r = await fetch(`${base}/hooks/agentmail`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id: `vet-${randomBytes(4).toString("hex")}`,
                  thread_id: null,
                  from: { address: "manager@vet.internal", name: "Vet Manager" },
                  to: [{ address: "test@vet.internal", name: "VetAgent" }],
                  subject: "Vetting test",
                  text: "This is a synthetic test. Please acknowledge.",
                  html: "<p>Synthetic test.</p>",
                  date: new Date().toISOString(),
                  inboxId: "vet-inbox",
                }),
                signal: AbortSignal.timeout(15_000),
              });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
            },
          },
        ];

        // Convert caller-supplied CustomTest definitions into runnable tests
        const customRunnable: HttpTest[] = customTests.map((ct) => ({
          name: ct.name,
          run: async () => {
            const method = (ct.method ?? "GET").toUpperCase();
            const expectStatus = ct.expectStatus ?? 200;
            const timeout = 20_000;
            const headers: Record<string, string> = {
              ...(ct.body !== undefined ? { "Content-Type": "application/json" } : {}),
              ...(ct.headers ?? {}),
            };
            const r = await fetch(`${base}${ct.endpoint}`, {
              method,
              headers,
              body: ct.body !== undefined ? JSON.stringify(ct.body) : undefined,
              signal: AbortSignal.timeout(timeout),
            });
            if (r.status !== expectStatus) {
              throw new Error(`Expected HTTP ${expectStatus}, got ${r.status}`);
            }
          },
        }));

        const httpTests: HttpTest[] = [
          ...(skipDefaultTests ? [] : builtInTests),
          ...customRunnable,
        ];

        const totalLabel = skipDefaultTests
          ? `${customRunnable.length} custom test(s)`
          : `${builtInTests.length} built-in + ${customRunnable.length} custom`;

        if (httpTests.length === 0) {
          report.steps.push({ name: "HTTP tests", status: "skip", detail: "no tests configured" });
        } else {
          let passed = 0;
          for (const test of httpTests) {
            try {
              await test.run();
              testResults.push({ name: test.name, passed: true });
              passed++;
            } catch (e: any) {
              testResults.push({ name: test.name, passed: false, error: e.message });
            }
          }

          const allPassed = passed === httpTests.length;
          report.steps.push({
            name: "HTTP tests",
            status: allPassed ? "pass" : "fail",
            detail: `${passed}/${httpTests.length} passed (${totalLabel})`,
            findings: testResults.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
          });
          if (!allPassed) report.overallStatus = "fail";
        }
      }
    }
  } catch (e: any) {
    if (!(e instanceof VetBuildError)) {
      // Unexpected error
      report.steps.push({ name: "Unexpected error", status: "fail", detail: e.message });
      report.overallStatus = "fail";
    }
  } finally {
    // Cleanup
    if (container) {
      try { await container.stop({ t: 5 }); } catch {}
      try { await container.remove({ force: true }); } catch {}
    }
    if (imageName) {
      try { const img = docker.getImage(imageName); await img.remove({ force: true }); } catch {}
    }
    if (buildDir) {
      try { rmSync(buildDir, { recursive: true, force: true }); } catch {}
    }
    if (packageDir && isBlobStoragePath(agentVersion?.storagePath ?? "")) {
      try { rmSync(packageDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Build summary text
  const passCount = report.steps.filter((s) => s.status === "pass").length;
  const failCount = report.steps.filter((s) => s.status === "fail").length;
  report.summary = `${passCount} step(s) passed, ${failCount} failed — overall: ${report.overallStatus.toUpperCase()}`;

  // Write results to DB
  await prisma.agentVersion.update({
    where: { id: versionId },
    data: {
      vetNotes: report.summary,
      testResults: report as any,
    },
  });

  console.log(`[vet-package] Done: ${report.summary}`);
}

// ── Build context assembly (mirrors custom-runner.ts) ────────────────────────

function assembleBuildContext(creatorPackageDir: string, slug: string): string {
  const buildDir = mkdtempSync(join(tmpdir(), `vet-build-${slug.slice(0, 8)}-`));
  const creatorDir = join(buildDir, "creator");
  mkdirSync(creatorDir, { recursive: true });

  // Copy creator files into creator/
  cpSync(creatorPackageDir, creatorDir, { recursive: true });

  // Copy platform adapter to root (works from both src/ and dist/)
  const fromDist = resolve(__dirname, "..", "templates", "runtime");
  const fromSrc  = resolve(__dirname, "..", "..", "src", "templates", "runtime");
  const adapterDir = existsSync(fromDist) ? fromDist : fromSrc;
  cpSync(adapterDir, buildDir, { recursive: true });

  // Inject approval block into AGENTS.md
  const agentsMdPath = join(creatorDir, "AGENTS.md");
  if (existsSync(agentsMdPath)) {
    const content = readFileSync(agentsMdPath, "utf-8");
    if (!content.includes("## Approval queue")) {
      writeFileSync(agentsMdPath, APPROVAL_BLOCK + content);
    }
  }

  // Remove reserved files from creator/
  for (const f of RESERVED_FILES) {
    const p = join(creatorDir, f);
    if (existsSync(p)) rmSync(p);
  }

  return buildDir;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function findPyFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".py")) results.push(full);
    }
  }
  walk(dir);
  return results;
}

class VetBuildError extends Error {}
