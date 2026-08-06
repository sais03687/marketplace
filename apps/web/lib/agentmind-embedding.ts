/**
 * Access to sentence embeddings for AgentMind, and the keyword fallback for when
 * they are unavailable.
 *
 * The model itself runs on the provisioning host — see
 * apps/provisioning-service/src/embedding.ts for why it lives there and why it is
 * local rather than a paid API. This module is only the client, plus the
 * similarity maths and the degraded path.
 */

const EMBED_TIMEOUT_MS = 10_000;

/** Cosine similarity above which a contribution is considered relevant.
 *
 * Measured against the live corpus with all-MiniLM-L6-v2: genuinely relevant
 * queries scored 0.67, clearly irrelevant ones 0.09–0.11, and one ambiguous case
 * ("email our vendor the quarterly numbers", against a corpus about file sharing)
 * landed at 0.20. 0.35 sits in the gap with room on both sides, and puts the
 * ambiguous case on the silent side — a missed hit is a wasted opportunity, an
 * injected wrong lesson actively misleads the agent.
 */
export const SIMILARITY_THRESHOLD = Number(process.env.AGENTMIND_SIMILARITY_THRESHOLD || "0.35");

function serviceBase(): string {
  return (
    process.env.PROVISIONING_SERVICE_URL ||
    process.env.PROVISIONING_URL ||
    "https://api.agentstore.it.com"
  ).replace(/\/$/, "");
}

/**
 * Embed texts, or return null if embeddings are unavailable.
 *
 * Null rather than throwing: every caller has a usable fallback, and a search
 * that silently degrades to keyword matching is better than one that 500s because
 * a model host is restarting.
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const secret = process.env.PROVISIONING_SECRET;
  if (!secret || texts.length === 0) return null;

  try {
    const resp = await fetch(`${serviceBase()}/internal/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[agentmind] Embedding service returned ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      console.warn("[agentmind] Embedding service returned an unexpected shape");
      return null;
    }
    return data.embeddings;
  } catch (err: any) {
    console.warn(`[agentmind] Embedding unavailable: ${err.message}`);
    return null;
  }
}

/** Vectors arrive L2-normalised, so cosine is a dot product. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** Near-identical: return the existing row instead of writing another. */
export const DUPLICATE_THRESHOLD = Number(
  process.env.AGENTMIND_DUPLICATE_THRESHOLD || "0.90",
);

/**
 * Same topic, different wording. Two or more neighbours at this distance means
 * the subject is already covered and another entry is a pile-up, not a lesson.
 *
 * 0.75 was measured, not guessed. Against the seven near-duplicate lessons that
 * taught the agent to refuse emailing its own manager, plus the one deliberately
 * kept and two unrelated controls, neighbour counts at this threshold were 3–5
 * for six of the seven and 0 for everything that should be kept. Pairwise
 * similarity across the seven ran 0.348–0.944 with a median of 0.762, so the
 * line sits just under the median of a genuine cluster and well above anything
 * unrelated.
 */
export const CLUSTER_THRESHOLD = Number(
  process.env.AGENTMIND_CLUSTER_THRESHOLD || "0.75",
);

export interface NeighbourHit {
  id: string;
  title: string;
  score: number;
}

/**
 * Existing rows semantically close to a candidate, nearest first.
 *
 * A linear scan and a threshold — k-nearest-neighbour counting, not clustering.
 * The question at write time is one candidate against the corpus, which needs no
 * k-means or DBSCAN and none of their tuning. Rows without a vector are skipped
 * rather than treated as distant, so an embedding outage cannot manufacture the
 * appearance of a novel lesson.
 */
export function findNeighbours(
  vector: number[],
  rows: Array<{ id: string; title: string; embedding: number[] | null }>,
  threshold: number,
): NeighbourHit[] {
  if (!vector?.length) return [];
  const hits: NeighbourHit[] = [];
  for (const row of rows) {
    if (!row.embedding?.length) continue;
    const score = cosineSimilarity(vector, row.embedding);
    if (score >= threshold) hits.push({ id: row.id, title: row.title, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/**
 * How long a lesson of each type stays trustworthy without another look.
 *
 * They do not age alike. A CORRECTION encodes a failure mode and goes stale the
 * moment the failure is fixed — #38 found one asserting Excel was unavailable,
 * learned from a corrupt test fixture that had since been replaced. A PATTERN
 * describes durable policy. Adjust here; nothing else reads these numbers.
 */
export const REVIEW_INTERVAL_DAYS: Record<string, number> = {
  CORRECTION: 30,
  RESPONSE_TEMPLATE: 90,
  TASK_RECIPE: 90,
  PATTERN: 180,
};

export function reviewDueDate(type: string, from: Date = new Date()): Date {
  const days = REVIEW_INTERVAL_DAYS[type] ?? 90;
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Was this lesson learned from something the agent actually did?
 *
 * Provenance is `Request: …` plus `Triggered by: …`, the second present only when
 * the run produced an action result (see maybe_contribute in agent.py). A lesson
 * making claims about what the platform permits, written by a run that never
 * asked the platform anything, is the agent generalising from its own reasoning.
 *
 * That is not hypothetical: both harmful lessons written after provenance was
 * added carried a Request and no Triggered by. The agent had refused
 * pre-emptively, then recorded a lesson about a refusal that never happened —
 * which is precisely how one bad lesson became seven.
 */
export function isFounded(context: string | null | undefined): boolean {
  return /(^|\n)\s*Triggered by:\s*\S/.test(context || "");
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "can", "you", "our", "about", "this", "that",
  "from", "have", "has", "are", "was", "were", "what", "when", "where", "how",
  "please", "would", "could", "should", "any", "all", "your", "his", "her",
  "their", "its", "into", "out", "not", "but", "may", "will", "shall", "does",
]);

/** Query terms for the fallback path: lowercase, de-duplicated, meaningful. */
export function tokenise(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of (query || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

/**
 * How many distinct query terms a contribution matches.
 *
 * The caller requires two or more before returning anything. One is how a single
 * common word like "external" drags in every unrelated lesson, and noise injected
 * into a prompt is worse than nothing at all.
 */
export function keywordScore(
  tokens: string[],
  row: { title: string; content: string; tags: string[] },
): number {
  const haystack = `${row.title} ${row.content}`.toLowerCase();
  const tags = (row.tags || []).map((t) => t.toLowerCase());
  let hits = 0;
  for (const t of tokens) {
    if (haystack.includes(t) || tags.includes(t)) hits++;
  }
  return hits;
}
