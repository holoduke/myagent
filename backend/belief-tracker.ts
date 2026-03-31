/**
 * Evolving Beliefs System (Research Improvement #8)
 * Inspired by Hindsight architecture.
 *
 * Manages belief nodes that evolve based on new evidence.
 * Beliefs have confidence scores that update when supporting or
 * contradicting evidence is observed.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { createLogger } from "./logger.js";

const log = createLogger("beliefs");

// ── Types ──

export interface BeliefUpdate {
  nodeId: string;
  direction: "strengthen" | "weaken" | "contradict";
  evidence: string;
  confidenceDelta: number;
}

// ── Belief Management ──

/**
 * Find all belief nodes in the graph.
 */
export function getBeliefs(graph: MemoryGraph): MemoryNode[] {
  return graph.findByType("belief");
}

/**
 * Get beliefs with their current confidence levels, sorted by confidence.
 */
export function getBeliefSummary(graph: MemoryGraph): string {
  const beliefs = getBeliefs(graph)
    .sort((a, b) => (b.confidence ?? 0.5) - (a.confidence ?? 0.5))
    .slice(0, 10);

  if (beliefs.length === 0) return "";

  const lines = beliefs.map(b => {
    const conf = b.confidence ?? 0.5;
    const confLabel = conf > 0.8 ? "high" : conf > 0.5 ? "medium" : conf > 0.3 ? "low" : "very low";
    return `- [${confLabel}] ${b.content.slice(0, 80)}`;
  });

  return lines.join("\n");
}

/**
 * Update belief confidence based on new evidence.
 * Called during think ticks when contradictions or confirmations are detected.
 */
export function updateBeliefConfidence(
  graph: MemoryGraph,
  updates: BeliefUpdate[],
): number {
  let updated = 0;

  for (const update of updates) {
    const node = graph.getNode(update.nodeId);
    if (!node || node.type !== "belief") continue;

    const oldConfidence = node.confidence ?? 0.5;
    const newConfidence = Math.max(0, Math.min(1, oldConfidence + update.confidenceDelta));

    // Update confidence and tag via graph.updateNode (avoids direct mutation)
    const updatedTags = node.tags.includes("evidence-updated")
      ? [...node.tags]
      : [...node.tags, "evidence-updated"];
    if (newConfidence < 0.2 && !updatedTags.includes("disputed")) {
      updatedTags.push("disputed");
    }

    graph.updateNode(update.nodeId, {
      tags: updatedTags,
      confidence: newConfidence,
    });

    // If contradicted, create a contradiction edge to the evidence
    if (update.direction === "contradict") {
      const metaId = `meta_belief_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      graph.applyOperations([{
        op: "add_node",
        id: metaId,
        type: "meta",
        content: `Belief update: "${node.content.slice(0, 50)}..." ${update.direction} by: ${update.evidence}`,
        tags: ["belief-update", "evidence"],
        strength: 0.4,
      }]);
      graph.applyOperations([{
        op: "add_edge",
        from: update.nodeId,
        to: metaId,
        type: "contradicts",
        weight: Math.abs(update.confidenceDelta),
      }]);
    }

    log(`Belief ${update.nodeId} confidence: ${oldConfidence.toFixed(2)} → ${newConfidence.toFixed(2)} (${update.direction})`);
    updated++;
  }

  return updated;
}

/**
 * Detect beliefs that should be reviewed based on age and conflicting evidence.
 * Returns belief nodes that might need updating.
 */
export function detectStaleBeliefs(graph: MemoryGraph): MemoryNode[] {
  const now = Date.now();
  const STALE_THRESHOLD = 30 * 24 * 3600_000; // 30 days

  return getBeliefs(graph).filter(belief => {
    // Old beliefs with medium confidence → might need review
    const isOld = now - belief.lastAccessedAt > STALE_THRESHOLD;
    const isMediumConfidence = (belief.confidence ?? 0.5) > 0.3 && (belief.confidence ?? 0.5) < 0.7;

    // Beliefs with contradicting edges → definitely need review
    const hasContradictions = graph.edgesFor(belief.id).some(e => e.type === "contradicts");

    return (isOld && isMediumConfidence) || hasContradictions;
  });
}
