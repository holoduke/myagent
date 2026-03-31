/**
 * Reflective Consolidation (Research: MaRS forgetting policies, MemOS deduplication)
 *
 * Before pruning weak memory clusters, summarize them into a single "gist" node
 * that preserves the semantic essence. This prevents information loss during decay
 * while keeping the graph lean.
 *
 * Example: 5 event nodes about "Alice's work project meetings" → 1 insight node
 * "Alice has been working on project X for 3 weeks, mentioned deadlines and blockers"
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("reflective-consolidation");

// ── Types ──

export interface ConsolidationCandidate {
  nodes: MemoryNode[];
  sharedTags: string[];
  averageStrength: number;
  totalContent: string;
}

export interface GistResult {
  gistNodeId: string;
  nodesConsolidated: number;
  summary: string;
}

// ── Cluster Detection ──

/**
 * Find clusters of weak, related nodes that can be consolidated into gist summaries.
 * Targets nodes with strength < threshold that share 2+ tags and are older than minAge.
 */
export function findConsolidationCandidates(
  graph: MemoryGraph,
  strengthThreshold = 0.3,
  minAge = 5 * 24 * 3600_000, // 5 days
  minClusterSize = 3,
): ConsolidationCandidate[] {
  const now = Date.now();
  const candidates: ConsolidationCandidate[] = [];

  // Get weak, old nodes grouped by type
  const weakNodes = graph.allNodes().filter(
    n => !n.pinned && n.strength < strengthThreshold && (now - n.createdAt) > minAge,
  );

  // Build tag→nodeId index
  const tagIndex = new Map<string, MemoryNode[]>();
  for (const node of weakNodes) {
    for (const tag of node.tags) {
      const key = tag.toLowerCase();
      if (!tagIndex.has(key)) tagIndex.set(key, []);
      tagIndex.get(key)!.push(node);
    }
  }

  // Find clusters: nodes sharing 2+ tags
  const used = new Set<string>();

  for (const node of weakNodes) {
    if (used.has(node.id)) continue;

    // Count co-occurring nodes via tag index
    const neighborCounts = new Map<string, number>();
    for (const tag of node.tags) {
      const key = tag.toLowerCase();
      const matches = tagIndex.get(key);
      if (!matches) continue;
      for (const match of matches) {
        if (match.id === node.id || used.has(match.id)) continue;
        neighborCounts.set(match.id, (neighborCounts.get(match.id) ?? 0) + 1);
      }
    }

    // Collect nodes with 2+ shared tags
    const cluster = [node];
    const sharedTagSet = new Set<string>();

    for (const [neighborId, overlap] of neighborCounts) {
      if (overlap >= 2) {
        const neighbor = weakNodes.find(n => n.id === neighborId);
        if (neighbor) {
          cluster.push(neighbor);
          // Track shared tags
          for (const tag of node.tags) {
            if (neighbor.tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
              sharedTagSet.add(tag.toLowerCase());
            }
          }
        }
      }
    }

    if (cluster.length >= minClusterSize) {
      for (const n of cluster) used.add(n.id);

      const avgStrength = cluster.reduce((s, n) => s + n.strength, 0) / cluster.length;
      const totalContent = cluster.map(n => n.content).join("\n---\n");

      candidates.push({
        nodes: cluster.slice(0, 10), // Cap cluster size
        sharedTags: [...sharedTagSet],
        averageStrength: avgStrength,
        totalContent: totalContent.slice(0, 1000),
      });
    }

    if (candidates.length >= 5) break; // Cap total candidates per pass
  }

  return candidates;
}

/**
 * Create a gist node that summarizes a cluster of weak nodes.
 * The gist preserves the key information while the originals can be safely pruned.
 */
export function createGistNode(
  graph: MemoryGraph,
  candidate: ConsolidationCandidate,
  summary: string,
): GistResult {
  const gistId = `gist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // Determine the best type for the gist (most common type in cluster)
  const typeCounts = new Map<string, number>();
  for (const node of candidate.nodes) {
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
  }
  const gistType = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "insight";

  // Create the gist node with boosted strength (it's a distillation)
  graph.applyOperations([{
    op: "add_node",
    id: gistId,
    type: gistType === "event" ? "insight" : gistType as any,
    content: `[gist] ${summary}`,
    tags: [...candidate.sharedTags, "gist", "reflective-consolidation"],
    strength: Math.max(0.4, candidate.averageStrength + 0.15),
    importance: 0.3,
  }]);

  // Weaken the original nodes (they'll be pruned naturally by decay)
  for (const node of candidate.nodes) {
    graph.applyOperations([{
      op: "weaken",
      id: node.id,
      amount: 0.15,
    }]);
  }

  log(`Created gist ${gistId} from ${candidate.nodes.length} nodes (tags: ${candidate.sharedTags.join(", ")})`);

  return {
    gistNodeId: gistId,
    nodesConsolidated: candidate.nodes.length,
    summary,
  };
}

/**
 * Build a simple rule-based summary from a consolidation candidate.
 * No LLM call needed — uses node content and metadata.
 */
export function buildGistSummary(candidate: ConsolidationCandidate): string {
  const nodeCount = candidate.nodes.length;
  const topics = candidate.sharedTags.slice(0, 3).join(", ");
  const types = [...new Set(candidate.nodes.map(n => n.type))].join("/");

  // Extract key phrases: first sentence of each node
  const keyPhrases = candidate.nodes
    .map(n => n.content.split(/[.\n]/)[0].trim())
    .filter(p => p.length > 10)
    .slice(0, 3);

  const phraseStr = keyPhrases.length > 0 ? ` Key points: ${keyPhrases.join("; ")}` : "";

  return `Summary of ${nodeCount} ${types} memories about ${topics}.${phraseStr}`;
}

/**
 * Run reflective consolidation: find clusters, summarize, create gists.
 */
export function runReflectiveConsolidation(graph: MemoryGraph): GistResult[] {
  const candidates = findConsolidationCandidates(graph);
  if (candidates.length === 0) return [];

  const results: GistResult[] = [];

  for (const candidate of candidates) {
    const summary = buildGistSummary(candidate);
    const result = createGistNode(graph, candidate, summary);
    results.push(result);
  }

  if (results.length > 0) {
    log(`Reflective consolidation: ${results.length} gist nodes created from ${results.reduce((s, r) => s + r.nodesConsolidated, 0)} weak nodes`);
  }

  return results;
}
