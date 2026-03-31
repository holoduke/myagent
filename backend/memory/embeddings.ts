/**
 * Semantic memory via vector embeddings.
 * Stores embeddings separately from nodes.json to keep it lean.
 * Provides cosine similarity search and hybrid merge with keyword activation.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import { embedSingle } from "../providers/embedding-provider.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";
import type { MemoryGraph } from "./graph.js";

const log = createLogger("embeddings");

const GRAPH_DIR = `${BRAIN_DIR}/graph`;
const EMBEDDINGS_FILE = `${GRAPH_DIR}/embeddings.json`;

// In-memory cache of embeddings: nodeId → vector
let embeddingCache: Map<string, number[]> | null = null;

function loadEmbeddings(): Map<string, number[]> {
  if (embeddingCache) return embeddingCache;

  const raw = safeReadJSON<Record<string, number[]>>(EMBEDDINGS_FILE, {});
  embeddingCache = new Map(Object.entries(raw));
  log(`Loaded ${embeddingCache.size} embeddings from disk`);
  return embeddingCache;
}

function saveEmbeddings(): void {
  if (!embeddingCache) return;
  ensureDir(GRAPH_DIR);
  const obj: Record<string, number[]> = {};
  for (const [id, vec] of embeddingCache) {
    obj[id] = vec;
  }
  atomicWriteJSON(EMBEDDINGS_FILE, obj, 0);
}

/**
 * Cosine similarity between two vectors.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Generate and store embedding for a node.
 * Non-blocking, fire-and-forget safe.
 */
export async function embedNode(nodeId: string, content: string): Promise<number[] | null> {
  try {
    const vector = await embedSingle(content);
    if (!vector) return null;

    const cache = loadEmbeddings();
    cache.set(nodeId, vector);

    // Debounced save (don't save on every single node)
    scheduleSave();

    return vector;
  } catch (err) {
    log(`Failed to embed node ${nodeId}: ${err}`);
    return null;
  }
}

// Debounced save to avoid excessive disk writes
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 5000;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveEmbeddings();
    saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

/**
 * Batch-embed all nodes that don't have embeddings yet.
 * Useful for migration of existing graphs.
 */
export async function batchEmbedMissing(graph: MemoryGraph): Promise<number> {
  const cache = loadEmbeddings();
  const missing: Array<{ id: string; content: string }> = [];

  for (const node of graph.allNodes()) {
    if (!cache.has(node.id)) {
      missing.push({ id: node.id, content: node.content });
    }
  }

  if (missing.length === 0) return 0;

  log(`Batch embedding ${missing.length} nodes without embeddings`);

  let embedded = 0;
  // Process in small batches to avoid rate limits
  for (const item of missing) {
    const vector = await embedSingle(item.content);
    if (vector) {
      cache.set(item.id, vector);
      embedded++;
    }
    // Small delay between individual embeddings
    if (embedded % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  saveEmbeddings();
  log(`Batch embedded ${embedded}/${missing.length} nodes`);
  return embedded;
}

/**
 * Semantic search: find nodes most similar to a query string.
 * Returns sorted by similarity, highest first.
 */
export async function semanticSearch(
  query: string,
  topK = 15,
): Promise<Array<{ nodeId: string; similarity: number }>> {
  const queryVector = await embedSingle(query);
  if (!queryVector) return [];

  return semanticSearchByVector(queryVector, topK);
}

/**
 * Semantic search using a pre-computed query vector.
 */
export function semanticSearchByVector(
  queryVector: number[],
  topK = 15,
): Array<{ nodeId: string; similarity: number }> {
  const cache = loadEmbeddings();
  if (cache.size === 0) return [];

  const results: Array<{ nodeId: string; similarity: number }> = [];

  for (const [nodeId, nodeVector] of cache) {
    const similarity = cosine(queryVector, nodeVector);
    if (similarity > 0.3) { // Minimum threshold
      results.push({ nodeId, similarity });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

/**
 * Remove embedding for a node (e.g., when node is archived/removed).
 */
export function removeEmbedding(nodeId: string): void {
  const cache = loadEmbeddings();
  if (cache.delete(nodeId)) {
    scheduleSave();
  }
}

/**
 * Get embedding count (for stats/dashboard).
 */
export function getEmbeddingCount(): number {
  return loadEmbeddings().size;
}

/**
 * Force save (for shutdown hooks).
 */
export function flushEmbeddings(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveEmbeddings();
}
