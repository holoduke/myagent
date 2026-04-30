/**
 * Causal Knowledge Graph (Research Improvement #7)
 * Inspired by REMI architecture.
 *
 * Tracks cause-effect relationships between events, detecting
 * causal chains that help predict consequences and inform decisions.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode, MemoryEdge } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("causal");

// ── Types ──

export interface CausalLink {
  causeNodeId: string;
  effectNodeId: string;
  confidence: number; // 0.0–1.0
  evidence: string;
}

export interface CausalChain {
  nodes: string[];
  totalConfidence: number;
  description: string;
}

// ── Causal Detection ──

// Temporal causal patterns: keyword pairs that suggest cause → effect
const CAUSAL_KEYWORDS: { cause: RegExp; effect: RegExp }[] = [
  { cause: /\b(because|since|due to|caused by|as a result of)\b/i, effect: /.*/ },
  { cause: /\b(after|following|once)\b/i, effect: /\b(then|so|therefore|resulted)\b/i },
  { cause: /\b(if|when|whenever)\b/i, effect: /\b(then|will|would|should)\b/i },
];

/**
 * Detect potential causal relationships between recent event nodes.
 * Uses temporal proximity + shared tags + causal language patterns.
 */
export function detectCausalLinks(graph: MemoryGraph): CausalLink[] {
  const links: CausalLink[] = [];
  const now = Date.now();
  const WINDOW = 48 * 3600_000; // 48h window

  // Get recent event and fact nodes
  const recentNodes = [...graph.findByType("event"), ...graph.findByType("fact")]
    .filter(n => now - n.createdAt < WINDOW)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Check existing edges to avoid duplicates
  const existingCausal = new Set<string>();
  for (const edge of graph.allEdges()) {
    if (edge.type === "causal") {
      existingCausal.add(`${edge.from}→${edge.to}`);
    }
  }

  // Pairwise comparison for temporal causality
  for (let i = 0; i < recentNodes.length; i++) {
    for (let j = i + 1; j < recentNodes.length; j++) {
      const earlier = recentNodes[i];
      const later = recentNodes[j];
      const key = `${earlier.id}→${later.id}`;

      if (existingCausal.has(key)) continue;

      // Time gap should be meaningful but not too large
      const gap = later.createdAt - earlier.createdAt;
      if (gap < 60_000 || gap > 24 * 3600_000) continue;

      // Check for shared tags (context overlap)
      const sharedTags = earlier.tags.filter(t =>
        later.tags.some(lt => lt.toLowerCase() === t.toLowerCase()),
      );
      if (sharedTags.length === 0) continue;

      // Check for causal language in content
      let hasCausalLanguage = false;
      for (const { cause, effect } of CAUSAL_KEYWORDS) {
        if (cause.test(later.content) || effect.test(later.content)) {
          hasCausalLanguage = true;
          break;
        }
      }

      // Score confidence based on signals
      let confidence = 0;
      confidence += Math.min(0.3, sharedTags.length * 0.1); // tag overlap
      confidence += hasCausalLanguage ? 0.3 : 0;              // language signal
      confidence += gap < 3600_000 ? 0.2 : 0.1;               // temporal proximity

      if (confidence >= 0.3) {
        links.push({
          causeNodeId: earlier.id,
          effectNodeId: later.id,
          confidence,
          evidence: `Shared tags: [${sharedTags.join(", ")}], gap: ${Math.round(gap / 60_000)}min`,
        });
      }
    }
  }

  return links;
}

/**
 * Record detected causal links as edges in the memory graph.
 */
export function recordCausalLinks(graph: MemoryGraph, links: CausalLink[]): number {
  let created = 0;

  for (const link of links) {
    // Verify both nodes still exist
    if (!graph.getNode(link.causeNodeId) || !graph.getNode(link.effectNodeId)) continue;

    graph.applyOperations([{
      op: "add_edge",
      from: link.causeNodeId,
      to: link.effectNodeId,
      type: "causal",
      weight: link.confidence,
    }]);
    created++;
  }

  if (created > 0) {
    log(`Recorded ${created} causal links`);
  }

  return created;
}

/**
 * Trace causal chains from a given node, following causal edges.
 * Returns chains up to depth 3.
 */
export function traceCausalChain(graph: MemoryGraph, startNodeId: string, maxDepth: number = 3): CausalChain[] {
  const chains: CausalChain[] = [];
  const visited = new Set<string>();

  function dfs(nodeId: string, chain: string[], confidence: number, depth: number): void {
    if (depth >= maxDepth || visited.has(nodeId)) return;
    visited.add(nodeId);

    const edges = graph.edgesFor(nodeId).filter(e => e.type === "causal" && e.from === nodeId);

    if (edges.length === 0 && chain.length > 1) {
      // End of chain
      const descriptions = chain.map(id => {
        const node = graph.getNode(id);
        return node ? node.content.slice(0, 40) : id;
      });
      chains.push({
        nodes: [...chain],
        totalConfidence: confidence,
        description: descriptions.join(" → "),
      });
      return;
    }

    for (const edge of edges) {
      dfs(edge.to, [...chain, edge.to], confidence * edge.weight, depth + 1);
    }

    // Do NOT delete from visited — prevents infinite recursion on cycles
  }

  dfs(startNodeId, [startNodeId], 1, 0);
  return chains;
}

/**
 * Generate causal context summary for the brain prompt.
 */
export function getCausalContextSummary(graph: MemoryGraph): string {
  const now = Date.now();
  const recentCausal = graph.allEdges()
    .filter(e => e.type === "causal" && now - e.createdAt < 7 * 24 * 3600_000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5);

  if (recentCausal.length === 0) return "";

  const lines = recentCausal.map(e => {
    const cause = graph.getNode(e.from);
    const effect = graph.getNode(e.to);
    if (!cause || !effect) return null;
    return `- "${cause.content.slice(0, 40)}" → "${effect.content.slice(0, 40)}" (conf: ${e.weight.toFixed(2)})`;
  }).filter(Boolean);

  return lines.join("\n");
}
