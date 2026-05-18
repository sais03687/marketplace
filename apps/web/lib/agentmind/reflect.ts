/**
 * LLM-powered reflection for AgentMind contributions.
 *
 * When a human edits or rejects an agent's draft, this module calls a fast LLM
 * to synthesize a thoughtful, reusable learning — instead of dumping raw diffs
 * into AgentMind.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReflectionContext {
  originalDraft: string;
  editedText?: string;
  rejectionReason?: string;
  taskType: string;
  originalRequest?: string;
}

export interface ReflectionResult {
  title: string;
  content: string;
  tags: string[];
}

// ─── Config ─────────────────────────────────────────────────────────────────

const LLM_API_KEY =
  process.env.AGENTMIND_REFLECTION_API_KEY ||
  process.env.LLM_API_KEY ||
  "";

const LLM_BASE_URL =
  process.env.AGENTMIND_REFLECTION_BASE_URL ||
  process.env.LLM_BASE_URL ||
  "https://openrouter.ai/api/v1";

const LLM_MODEL =
  process.env.AGENTMIND_REFLECTION_MODEL ||
  "google/gemini-2.5-flash";

const TIMEOUT_MS = 20_000;

// ─── Prompt ─────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI agent reflecting on human feedback to your work.
Given the context of an approval that was edited or rejected,
produce a concise, actionable learning.

Your reflection must include:
1. WHAT WENT WRONG — What specific aspect of your approach was off?
2. WHY — What assumption or pattern led to the mistake?
3. THE LESSON — A concrete, reusable guideline for future similar tasks.
4. PREVENTION — What check or step should you add to your process?

Be specific and actionable. Do NOT just restate the diff.
Write from first person ("I should..."). Keep it under 200 words.

/no_think`;

function buildUserMessage(ctx: ReflectionContext): string {
  const feedbackLine =
    ctx.editedText !== undefined
      ? `Human feedback: EDITED — Changed to: "${ctx.editedText}"`
      : `Human feedback: REJECTED — Reason: "${ctx.rejectionReason || "not specified"}"`;

  return [
    `Task type: ${ctx.taskType}`,
    ctx.originalRequest ? `Original request: ${ctx.originalRequest}` : "",
    "",
    `My draft: "${ctx.originalDraft}"`,
    "",
    feedbackLine,
    "",
    "Reflect on this feedback and produce a learning.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── Fallback ───────────────────────────────────────────────────────────────

function buildFallback(ctx: ReflectionContext): ReflectionResult {
  const action = ctx.editedText !== undefined ? "edited" : "rejected";
  const tag = ctx.taskType.toLowerCase().replace(/\s+/g, "-");
  return {
    title: `${action === "edited" ? "Edited" : "Rejected"} draft for ${ctx.taskType}`,
    content: `Draft for ${ctx.taskType} was ${action}. Review original approach before similar tasks.`,
    tags: [tag, action === "edited" ? "edit-correction" : "rejection"],
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function generateReflection(
  ctx: ReflectionContext,
): Promise<ReflectionResult> {
  if (!LLM_API_KEY) {
    console.warn("[reflect] No LLM API key configured — using fallback");
    return buildFallback(ctx);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(ctx) },
        ],
        max_tokens: 400,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[reflect] LLM returned ${resp.status}: ${text}`);
      return buildFallback(ctx);
    }

    const json = (await resp.json()) as {
      choices?: { message?: { content?: string; reasoning?: string } }[];
    };
    const msg = json.choices?.[0]?.message;
    // Some reasoning models (e.g. Qwen3) put output in `reasoning` when `content` is empty
    const reflectionText = (msg?.content || msg?.reasoning || "").trim();

    if (!reflectionText) {
      console.warn("[reflect] Empty LLM response — using fallback");
      return buildFallback(ctx);
    }

    const action = ctx.editedText !== undefined ? "edited" : "rejected";
    const tag = ctx.taskType.toLowerCase().replace(/\s+/g, "-");

    return {
      title: `${action === "edited" ? "Edited" : "Rejected"} draft for ${ctx.taskType}`,
      content: reflectionText,
      tags: [tag, action === "edited" ? "edit-correction" : "rejection"],
    };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn("[reflect] LLM call timed out — using fallback");
    } else {
      console.error("[reflect] LLM call failed:", err);
    }
    return buildFallback(ctx);
  } finally {
    clearTimeout(timer);
  }
}
