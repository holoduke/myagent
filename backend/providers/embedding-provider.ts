/**
 * Embedding provider. Defaults to OpenAI text-embedding-3-small (1536d, ~$0.02/1M tokens),
 * configurable via EMBEDDING_MODEL / EMBEDDING_API_URL env vars for newer/alternative models.
 * Batches up to 100 texts, rate limited to 3 concurrent requests.
 */

import { createLogger } from "../logger.js";

const log = createLogger("embeddings");

const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL || "https://api.openai.com/v1/embeddings";
// Default: OpenAI text-embedding-3-small (1536d, cheap). Override via EMBEDDING_MODEL to adopt a
// newer model (e.g. text-embedding-3-large, voyage-3.1, gemini-embedding) without code changes.
// Note: changing models invalidates the vector space — old stored embeddings of a different
// dimension are handled gracefully by cosineSimilarity (returns 0 on dimension mismatch) and get
// re-embedded lazily as nodes are touched.
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const MAX_BATCH_SIZE = 100;
const MAX_CONCURRENT = 3;

let activeRequests = 0;

/**
 * Generate embeddings for one or more texts.
 * Returns an array of embedding vectors (number[][]).
 * Returns empty array on failure.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OPENAI_API_KEY not set — skipping embeddings");
    return [];
  }

  if (texts.length === 0) return [];

  // Split into batches
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
  }

  const allEmbeddings: number[][] = [];

  for (const batch of batches) {
    // Rate limit: wait if too many concurrent requests
    while (activeRequests >= MAX_CONCURRENT) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    activeRequests++;
    try {
      const embeddings = await embedBatch(batch, apiKey);
      allEmbeddings.push(...embeddings);
    } finally {
      activeRequests--;
    }
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single text. Convenience wrapper.
 */
export async function embedSingle(text: string): Promise<number[] | null> {
  const results = await embed([text]);
  return results.length > 0 ? results[0] : null;
}

async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  try {
    const response = await fetch(EMBEDDING_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      log(`Embedding API error ${response.status}: ${errorText.slice(0, 200)}`);
      return [];
    }

    const result = await response.json() as {
      data?: Array<{ embedding: number[]; index: number }>;
    };

    if (!result.data || !Array.isArray(result.data)) {
      log("Embedding API returned no data");
      return [];
    }

    // Sort by index to maintain order
    const sorted = result.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => d.embedding);
  } catch (err) {
    log(`Embedding batch failed: ${err}`);
    return [];
  }
}

// Singleton accessor
let instance: { embed: typeof embed; embedSingle: typeof embedSingle } | null = null;

export function getEmbeddingProvider(): { embed: typeof embed; embedSingle: typeof embedSingle } {
  if (!instance) {
    instance = { embed, embedSingle };
  }
  return instance;
}
