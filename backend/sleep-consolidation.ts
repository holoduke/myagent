/**
 * Conflict-Aware Sleep Consolidation (Research Improvement #3)
 * Inspired by SleepGate architecture.
 *
 * Enhanced consolidation that runs during quiet hours:
 * - Detects contradicting facts and resolves them
 * - Deduplicates near-identical nodes
 * - Promotes frequently-accessed episodic memories to semantic
 * - Merges overlapping emotion signals
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";
import { getNodeEmbedding, cosine } from "./memory/embeddings.js";

const log = createLogger("sleep-consolidation");

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

/**
 * Simple token overlap similarity (Jaccard-like).
 */
function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  return intersection / Math.max(tokensA.size, tokensB.size);
}

/**
 * Detect conflicting or near-duplicate facts in the graph.
 */
export function detectConflicts(graph: MemoryGraph): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  const factNodes = [...graph.findByType("fact"), ...graph.findByType("belief")];

  // Only check recent/active nodes to bound computation
  const active = factNodes
    .filter(n => n.strength > 0.1)
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
    .slice(0, 100);

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];

      // Must share at least one tag
      const sharedTags = a.tags.filter(t => b.tags.includes(t));
      if (sharedTags.length === 0) continue;

      const tokenSim = tokenSimilarity(a.content, b.content);

      // Semantic similarity via embeddings — catches conflicts that share meaning but not words
      // e.g. "Gillis works at NewStory" vs "Gillis joined Company X"
      let semanticSim = 0;
      const embA = getNodeEmbedding(a.id);
      const embB = getNodeEmbedding(b.id);
      if (embA && embB) {
        semanticSim = cosine(embA, embB);
      }

      // Combined similarity: use the higher of token or semantic similarity
      const similarity = Math.max(tokenSim, semanticSim);

      // Near-duplicate: very high similarity (token or semantic)
      if (similarity > 0.7) {
        pairs.push({
          nodeA: a,
          nodeB: b,
          conflictType: "near-duplicate",
          similarity,
        });
        continue;
      }

      // Contradiction: check for contradicting edges between them
      const hasContradiction = graph.edgesFor(a.id)
        .some(e => e.type === "contradicts" && (e.from === b.id || e.to === b.id));

      if (hasContradiction) {
        pairs.push({
          nodeA: a,
          nodeB: b,
          conflictType: "contradiction",
          similarity,
        });
        continue;
      }

      // Semantic near-miss: high embedding similarity with shared tags but low token overlap
      // These are likely about the same topic with different wording — potential contradictions
      if (semanticSim > 0.6 && tokenSim < 0.4 && sharedTags.length >= 1) {
        pairs.push({
          nodeA: a,
          nodeB: b,
          conflictType: "contradiction",
          similarity: semanticSim,
        });
        continue;
      }

      // Superseded: same topic but one is much newer with validUntil set
      if (similarity > 0.4 && a.validUntil && a.validUntil < Date.now()) {
        pairs.push({
          nodeA: a,
          nodeB: b,
          conflictType: "superseded",
          similarity,
        });
      }
    }
  }

  return pairs;
}

/**
 * Resolve detected conflicts by merging duplicates and weakening contradictions.
 */
export function resolveConflicts(graph: MemoryGraph, pairs: ConflictPair[]): number {
  let resolved = 0;

  for (const pair of pairs) {
    switch (pair.conflictType) {
      case "near-duplicate": {
        // Keep the stronger/newer node, merge content
        const [keep, remove] = pair.nodeA.strength >= pair.nodeB.strength
          ? [pair.nodeA, pair.nodeB]
          : [pair.nodeB, pair.nodeA];

        graph.applyOperations([{
          op: "merge_nodes",
          ids: [keep.id, remove.id],
          into: {
            content: keep.content,
            tags: [...new Set([...keep.tags, ...remove.tags])],
          },
        }]);
        resolved++;
        break;
      }

      case "contradiction": {
        // Weaken the older/weaker one
        const weaker = pair.nodeA.strength <= pair.nodeB.strength ? pair.nodeA : pair.nodeB;
        graph.applyOperations([{
          op: "weaken",
          id: weaker.id,
          amount: 0.2,
        }]);
        resolved++;
        break;
      }

      case "superseded": {
        // Accelerate decay of superseded fact
        graph.applyOperations([{
          op: "weaken",
          id: pair.nodeA.id,
          amount: 0.3,
        }]);
        resolved++;
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
  let promoted = 0;

  const eventNodes = graph.findByType("event")
    .filter(n =>
      n.accessCount >= ACCESS_THRESHOLD &&
      now - n.createdAt > AGE_THRESHOLD &&
      n.strength > 0.3 &&
      !n.tags.includes("promoted-to-semantic"),
    );

  for (const node of eventNodes) {
    // Add tag and boost strength/importance via updateNode (avoids direct mutation)
    graph.updateNode(node.id, {
      tags: [...node.tags, "promoted-to-semantic"],
      strength: Math.min(1, node.strength + 0.1),
      importance: Math.max(node.importance ?? 0, 0.4),
    });

    promoted++;
  }

  if (promoted > 0) {
    log(`Promoted ${promoted} episodic memories to semantic`);
  }

  return promoted;
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
