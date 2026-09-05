/**
 * Reflective Consolidation (Research: MaRS forgetting policies, MemOS deduplication)
 *
 * Before pruning weak memory clusters, summarize them into a single "gist" node
 * that preserves the semantic essence. The originals are tagged with the gist
 * they were folded into and archived — recoverable, but out of the active
 * graph so the same cluster is never consolidated twice.
 *
 * Example: 5 event nodes about "Alice's work project meetings" → 1 insight node
 * "Alice has been working on project X for 3 weeks, mentioned deadlines and blockers"
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode, NodeType } from "./memory/types.js";
import { clusterByTagOverlap } from "./memory/text-utils.js";
import { createLogger } from "./logger.js";

const log = createLogger("reflective-consolidation");

export const GIST_TAG = "gist";
export const CONSOLIDATED_TAG_PREFIX = "consolidated:";
const MAX_CANDIDATES_PER_PASS = 5;
const MAX_CLUSTER_SIZE = 10;

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

/** Gists themselves and nodes already folded into one never re-enter a cluster. */
export function isConsolidationExempt(node: MemoryNode): boolean {
  return node.tags.some(t => t.toLowerCase() === GIST_TAG || t.toLowerCase().startsWith(CONSOLIDATED_TAG_PREFIX));
}

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
  const weakNodes = graph.allNodes().filter(
    n => !n.pinned && n.strength < strengthThreshold && (now - n.createdAt) > minAge && !isConsolidationExempt(n),
  );

  return clusterByTagOverlap(weakNodes, {
    minSharedTags: 2,
    minClusterSize,
    maxClusterSize: MAX_CLUSTER_SIZE,
    maxClusters: MAX_CANDIDATES_PER_PASS,
  }).map(cluster => ({
    nodes: cluster.nodes,
    sharedTags: cluster.sharedTags,
    averageStrength: cluster.nodes.reduce((s, n) => s + n.strength, 0) / cluster.nodes.length,
    totalContent: cluster.nodes.map(n => n.content).join("\n---\n").slice(0, 1000),
  }));
}

function dominantType(nodes: MemoryNode[]): NodeType {
  const counts = new Map<NodeType, number>();
  for (const node of nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "insight";
  return top === "event" ? "insight" : top;
}

/**
 * Create a gist node that summarizes a cluster of weak nodes, then tag and
 * archive the originals so the gist stands in for them.
 */
export function createGistNode(
  graph: MemoryGraph,
  candidate: ConsolidationCandidate,
  summary: string,
): GistResult {
  const gistId = `gist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  graph.applyOperations([{
    op: "add_node",
    id: gistId,
    type: dominantType(candidate.nodes),
    content: `[gist] ${summary}`,
    tags: [...candidate.sharedTags, GIST_TAG, "reflective-consolidation"],
    strength: Math.max(0.4, candidate.averageStrength + 0.15),
    importance: 0.3,
  }]);

  let archived = 0;
  for (const node of candidate.nodes) {
    graph.updateNode(node.id, { tags: [...node.tags, `${CONSOLIDATED_TAG_PREFIX}${gistId}`] });
    if (graph.archiveNode(node.id, "consolidation")) archived++;
  }

  log(`Created gist ${gistId} from ${candidate.nodes.length} nodes (${archived} archived; tags: ${candidate.sharedTags.join(", ")})`);

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

  const results = candidates.map(candidate => createGistNode(graph, candidate, buildGistSummary(candidate)));
  log(`Reflective consolidation: ${results.length} gist nodes created from ${results.reduce((s, r) => s + r.nodesConsolidated, 0)} weak nodes`);
  return results;
}
