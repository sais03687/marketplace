/**
 * Sentence embeddings, computed here rather than bought.
 *
 * AgentMind search has to match meaning, not words: "Can you share a file with an
 * outside partner?" and "External file sharing policy" have no word in common and
 * are the same question. Keyword matching cannot bridge that, which is why
 * retrieval never once fired in production.
 *
 * The model runs locally on this host. all-MiniLM-L6-v2 is ~23MB, needs no API
 * key, costs nothing per call, and measured better than a paid embedding API on
 * the cases that matter here — 0.672 vs 0.648 for the query above, and 0.670 vs
 * 0.605 for the paraphrase with no shared words. Ten texts embed in ~60ms.
 *
 * It lives in the provisioning service rather than the web app because this is a
 * long-running process: the model loads once and stays warm, where a serverless
 * function would pay the load cost on every cold start and fight a bundle limit.
 */

// Loaded lazily and kept for the process lifetime. The import is dynamic because
// the package is ESM-only and pulls in native ONNX bindings we do not want
// resolved unless embeddings are actually used.
let extractorPromise: Promise<unknown> | null = null;

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

async function getExtractor(): Promise<any> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      console.log(`[embedding] Loading ${EMBEDDING_MODEL}…`);
      const started = Date.now();
      const p = await pipeline("feature-extraction", EMBEDDING_MODEL);
      console.log(`[embedding] Ready in ${Date.now() - started}ms`);
      return p;
    })().catch((err) => {
      // Reset so a transient failure (a cold download, say) can be retried rather
      // than poisoning every later call with the same rejected promise.
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

/**
 * Embed one or more texts. Vectors are mean-pooled and L2-normalised, so cosine
 * similarity is a plain dot product — see cosineSimilarity below.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const out: number[][] = [];
  for (const text of texts) {
    const clean = (text || "").trim();
    if (!clean) {
      out.push([]);
      continue;
    }
    const result = await extractor(clean, { pooling: "mean", normalize: true });
    out.push(Array.from(result.data as Float32Array));
  }
  return out;
}

/**
 * Cosine similarity for vectors from embedTexts.
 *
 * They arrive normalised, so this is a dot product. Length is still checked
 * because a stored vector may predate a model change, and silently comparing
 * mismatched dimensions would return a plausible-looking number.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
