/**
 * Conflict-Aware Sleep Consolidation (Research Improvement #3)
 * Inspired by SleepGate architecture.
 *
 * Enhanced consolidation that runs during quiet hours:
 * - Detects contradicting facts and resolves them
 * - Deduplicates near-identical nodes (loser archived, never deleted)
 * - Promotes frequently-accessed episodic memories to semantic
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";
import { getNodeEmbedding, cosine } from "./memory/embeddings.js";
import { tokenJaccard, tokenOverlap } from "./memory/text-utils.js";

const log = createLogger("sleep-consolidation");

// ── Thresholds ──

/** Near-duplicate needs BOTH: semantic agreement and real wording overlap. */
export const DUPLICATE_MIN_COSINE = 0.85;
export const DUPLICATE_MIN_JACCARD = 0.5;
/** A semantic near-miss only counts as a contradiction when the texts actually share vocabulary. */
export const CONTRADICTION_MIN_COSINE = 0.6;
export const CONTRADICTION_MIN_TOKEN_OVERLAP = 0.3;
const SUPERSEDED_MIN_SIMILARITY = 0.4;
const MAX_ACTIVE_FACTS = 100;

// ── Types ──

export interface ConflictPair {
  nodeA: MemoryNode;
  nodeB: MemoryNode;
  conflictType: "contradiction" | "near-duplicate" | "superseded";
  similarity: number;
  resolution?: string;
}

export interface SleepConsolidationResult {
  conflictsDetected: number;
  conflictsResolved: number;
  duplicatesMerged: number;
  promotedToSemantic: number;
}

// ── Conflict Detection ──

interface PairSimilarity {
  cosine: number | null;
  jaccard: number;
  overlap: number;
}

function similarityFor(a: MemoryNode, b: MemoryNode): PairSimilarity {
  const embA = getNodeEmbedding(a.id);
  const embB = getNodeEmbedding(b.id);
  return {
    cosine: embA && embB ? cosine(embA, embB) : null,
    jaccard: tokenJaccard(a.content, b.content),
    overlap: tokenOverlap(a.content, b.content),
  };
}

function hasContradictsEdge(graph: MemoryGraph, a: MemoryNode, b: MemoryNode): boolean {
  return graph.edgesFor(a.id).some(e => e.type === "contradicts" && (e.from === b.id || e.to === b.id));
}

function classifyPair(graph: MemoryGraph, a: MemoryNode, b: MemoryNode): ConflictPair | null {
  const sim = similarityFor(a, b);

  if (sim.cosine !== null && sim.cosine > DUPLICATE_MIN_COSINE && sim.jaccard >= DUPLICATE_MIN_JACCARD) {
    return { nodeA: a, nodeB: b, conflictType: "near-duplicate", similarity: Math.min(sim.cosine, sim.jaccard) };
  }
  if (hasContradictsEdge(graph, a, b)) {
    return { nodeA: a, nodeB: b, conflictType: "contradiction", similarity: sim.cosine ?? sim.jaccard };
  }
  // Semantic near-miss: same meaning, different wording — but the wording must
  // still overlap, or "shares a tag + vaguely related" would weaken real memories.
  if (sim.cosine !== null && sim.cosine > CONTRADICTION_MIN_COSINE && sim.overlap >= CONTRADICTION_MIN_TOKEN_OVERLAP) {
    return { nodeA: a, nodeB: b, conflictType: "contradiction", similarity: sim.cosine };
  }
  const similarity = Math.max(sim.cosine ?? 0, sim.jaccard);
  if (similarity > SUPERSEDED_MIN_SIMILARITY && a.validUntil && a.validUntil < Date.now()) {
    return { nodeA: a, nodeB: b, conflictType: "superseded", similarity };
  }
  return null;
}

/**
 * Detect conflicting or near-duplicate facts in the graph. Only pairs that
 * share at least one tag are compared, bounded to the most recent facts.
 */
export function detectConflicts(graph: MemoryGraph): ConflictPair[] {
  const active = [...graph.findByType("fact"), ...graph.findByType("belief")]
    .filter(n => n.strength > 0.1)
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, MAX_ACTIVE_FACTS);

  const pairs: ConflictPair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (!a.tags.some(t => b.tags.includes(t))) continue;
      const pair = classifyPair(graph, a, b);
      if (pair) pairs.push(pair);
    }
  }
  return pairs;
}

// ── Resolution ──

/**
 * Fold `loser` into `keeper`: union tags, note the merged content on the
 * keeper, rewire the loser's edges, then archive the loser (its content stays
 * recoverable in cold storage).
 */
function mergeDuplicate(graph: MemoryGraph, keeper: MemoryNode, loser: MemoryNode): boolean {
  if (!graph.getNode(keeper.id) || !graph.getNode(loser.id)) return false;
  if (loser.pinned) return false;

  const mergeNote = `\n[merged ${new Date().toISOString().slice(0, 10)} from ${loser.id}: ${loser.content.slice(0, 300)}]`;
  graph.updateNode(keeper.id, {
    content: keeper.content + mergeNote,
    tags: [...new Set([...keeper.tags, ...loser.tags])],
  });

  const now = Date.now();
  for (const edge of graph.edgesFor(loser.id)) {
    const from = edge.from === loser.id ? keeper.id : edge.from;
    const to = edge.to === loser.id ? keeper.id : edge.to;
    if (from === to) continue;
    graph.addEdge({ ...edge, from, to, lastReinforcedAt: now });
  }

  return graph.archiveNode(loser.id, "consolidation");
}

/**
 * Resolve detected conflicts by merging duplicates and weakening contradictions.
 */
export function resolveConflicts(graph: MemoryGraph, pairs: ConflictPair[]): number {
  let resolved = 0;

  for (const pair of pairs) {
    switch (pair.conflictType) {
      case "near-duplicate": {
        const [keep, remove] = pair.nodeA.strength >= pair.nodeB.strength
          ? [pair.nodeA, pair.nodeB]
          : [pair.nodeB, pair.nodeA];
        if (mergeDuplicate(graph, keep, remove)) resolved++;
        break;
      }
      case "contradiction": {
        const weaker = pair.nodeA.strength <= pair.nodeB.strength ? pair.nodeA : pair.nodeB;
        if (graph.applyOperations([{ op: "weaken", id: weaker.id, amount: 0.2 }]).applied > 0) resolved++;
        break;
      }
      case "superseded": {
        if (graph.applyOperations([{ op: "weaken", id: pair.nodeA.id, amount: 0.3 }]).applied > 0) resolved++;
        break;
      }
    }
  }

  if (resolved > 0) {
    log(`Resolved ${resolved}/${pairs.length} conflicts`);
  }
  return resolved;
}

/**
 * Promote frequently-accessed episodic (event) memories to semantic (fact/insight).
 * Events that have been accessed many times become persistent knowledge.
 */
export function promoteEpisodicToSemantic(graph: MemoryGraph): number {
  const ACCESS_THRESHOLD = 10;
  const AGE_THRESHOLD = 7 * 24 * 3600_000; // 7 days old
  const now = Date.now();

  const eventNodes = graph.findByType("event")
    .filter(n =>
      n.accessCount >= ACCESS_THRESHOLD &&
      now - n.createdAt > AGE_THRESHOLD &&
      n.strength > 0.3 &&
      !n.tags.includes("promoted-to-semantic"),
    );

  for (const node of eventNodes) {
    graph.updateNode(node.id, {
      tags: [...node.tags, "promoted-to-semantic"],
      strength: Math.min(1, node.strength + 0.1),
      importance: Math.max(node.importance ?? 0, 0.4),
    });
  }

  if (eventNodes.length > 0) {
    log(`Promoted ${eventNodes.length} episodic memories to semantic`);
  }
  return eventNodes.length;
}

/**
 * Run the full sleep consolidation pass.
 */
export function runSleepConsolidation(graph: MemoryGraph): SleepConsolidationResult {
  const conflicts = detectConflicts(graph);
  const resolved = resolveConflicts(graph, conflicts);
  const promoted = promoteEpisodicToSemantic(graph);

  const result: SleepConsolidationResult = {
    conflictsDetected: conflicts.length,
    conflictsResolved: resolved,
    duplicatesMerged: conflicts.filter(p => p.conflictType === "near-duplicate").length,
    promotedToSemantic: promoted,
  };

  log(`Sleep consolidation: ${result.conflictsDetected} conflicts, ${result.conflictsResolved} resolved, ${result.promotedToSemantic} promoted`);
  return result;
}
