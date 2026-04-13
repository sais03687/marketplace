import express from "express";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const app = express();
app.use(express.json());

const PORT = 4000;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID || "unknown";
const WEBHOOK_TOKEN = process.env.APPROVAL_WEBHOOK_TOKEN || "";
const WORKSPACE = "/agent/workspace";
const DATA_DIR = `/data/${DEPLOYMENT_ID}`;

// Ensure data directory exists
mkdirSync(join(DATA_DIR, "resolutions"), { recursive: true });

// Auth middleware — verify deployment token
function authMiddleware(req, res, next) {
  // Health check is public
  if (req.path === "/internal/health") return next();

  const token = req.headers["x-deployment-token"];
  if (!token || token !== WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Invalid deployment token" });
  }
  next();
}

app.use(authMiddleware);

// ─── Health Check ────────────────────────────────────────────────────────────

const startTime = Date.now();

app.get("/internal/health", (_req, res) => {
  res.json({
    status: "healthy",
    deploymentId: DEPLOYMENT_ID,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

// ─── Resolve Approval ────────────────────────────────────────────────────────

app.post("/internal/approvals/:id/resolve", (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body;

  const resolutionPath = join(DATA_DIR, "resolutions", `${id}.json`);
  const resolution = {
    approvalId: id,
    status,
    note: note || "",
    resolvedAt: new Date().toISOString(),
  };

  writeFileSync(resolutionPath, JSON.stringify(resolution, null, 2));
  res.json({ ok: true, resolution });
});

// ─── Update Skills ───────────────────────────────────────────────────────────

app.post("/internal/update-skills", (req, res) => {
  const { files } = req.body;

  if (!files || typeof files !== "object") {
    return res.status(400).json({ error: "files object required" });
  }

  let updated = 0;
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(WORKSPACE, relativePath);
    const dir = join(fullPath, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
    updated++;
  }

  res.json({ ok: true, filesUpdated: updated });
});

// ─── Read Memory ─────────────────────────────────────────────────────────────

app.get("/internal/memory", (_req, res) => {
  const memoryPath = join(WORKSPACE, "MEMORY.md");
  let memory = "";
  if (existsSync(memoryPath)) {
    memory = readFileSync(memoryPath, "utf-8");
  }

  // Also collect daily notes
  const memoryDir = join(WORKSPACE, "memory");
  const dailyNotes = {};
  if (existsSync(memoryDir)) {
    for (const file of readdirSync(memoryDir)) {
      if (file.endsWith(".md")) {
        dailyNotes[file] = readFileSync(join(memoryDir, file), "utf-8");
      }
    }
  }

  res.json({ memory, dailyNotes });
});

// ─── Approval Policy Hot-Reload ──────────────────────────────────────────────

app.post("/internal/approval-policy", (req, res) => {
  const { policySection } = req.body;
  if (!policySection) {
    return res.status(400).json({ error: "policySection required" });
  }

  const agentsMdPath = join(WORKSPACE, "AGENTS.md");
  if (!existsSync(agentsMdPath)) {
    return res.status(404).json({ error: "AGENTS.md not found" });
  }

  let content = readFileSync(agentsMdPath, "utf-8");
  // Replace existing policy section (between markers) or append
  const START = "<!-- APPROVAL_POLICY_SECTION";
  const idx = content.indexOf(START);
  if (idx >= 0) {
    content = content.substring(0, idx) + policySection;
  } else {
    content += "\n\n" + policySection;
  }
  writeFileSync(agentsMdPath, content);
  res.json({ ok: true });
});

// ─── Start Onboarding ────────────────────────────────────────────────────────

app.post("/internal/start-onboarding", (_req, res) => {
  const triggerPath = join(DATA_DIR, "onboarding-trigger.json");
  writeFileSync(
    triggerPath,
    JSON.stringify({
      triggered: true,
      triggeredAt: new Date().toISOString(),
      deploymentId: DEPLOYMENT_ID,
    }),
  );
  res.json({ ok: true, message: "Onboarding trigger written" });
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[internal-api] Listening on port ${PORT} (deployment: ${DEPLOYMENT_ID})`);
});
