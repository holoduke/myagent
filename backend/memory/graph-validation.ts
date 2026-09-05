/**
 * Load-time integrity repair for the memory graph. Pure: takes the loaded
 * nodes/edges and returns repaired copies plus a summary. Nothing here touches
 * disk — the caller marks the graph dirty and an explicit save() persists.
 */

import type { MemoryNode, MemoryEdge } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("graph");

export interface RepairSummary {
  phantomEdges: number;
  selfLoops: number;
  nodeFields: number;
  weightsClamped: number;
  duplicateEdges: number;
}

export interface ValidatedGraph {
  nodes: Map<string, MemoryNode>;
  edges: MemoryEdge[];
  repaired: boolean;
  summary: RepairSummary;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Repair NaN/out-of-range numeric fields on a node; returns the node itself when clean. */
function repairNode(id: string, node: MemoryNode): { node: MemoryNode; fixes: number } {
  let fixes = 0;
  const changes: Partial<MemoryNode> = {};

  if (!Number.isFinite(node.strength)) {
    log(`Graph validation: node ${id} has invalid strength (${node.strength}), resetting to 0.5`);
    changes.strength = 0.5;
    fixes++;
  } else if (node.strength < 0 || node.strength > 1) {
    changes.strength = clamp01(node.strength);
    fixes++;
  }

  if (node.importance !== undefined) {
    if (!Number.isFinite(node.importance)) {
      log(`Graph validation: node ${id} has invalid importance (${node.importance}), resetting to 0.5`);
      changes.importance = 0.5;
      fixes++;
    } else if (node.importance < 0 || node.importance > 1) {
      changes.importance = clamp01(node.importance);
      fixes++;
    }
  }

  if (!Number.isFinite(node.lastAccessedAt)) {
    log(`Graph validation: node ${id} has invalid lastAccessedAt (${node.lastAccessedAt}), resetting to now`);
    changes.lastAccessedAt = Date.now();
    fixes++;
  }

  return fixes === 0 ? { node, fixes } : { node: { ...node, ...changes }, fixes };
}

function repairEdgeWeight(edge: MemoryEdge): { edge: MemoryEdge; fixed: boolean } {
  if (!Number.isFinite(edge.weight)) {
    log(`Graph validation: edge ${edge.from}->${edge.to} has invalid weight (${edge.weight}), resetting to 0.5`);
    return { edge: { ...edge, weight: 0.5 }, fixed: true };
  }
  if (edge.weight < 0 || edge.weight > 1) {
    return { edge: { ...edge, weight: clamp01(edge.weight) }, fixed: true };
  }
  return { edge, fixed: false };
}

/** Keep the highest-weight edge per (from, to, type). */
function dedupeEdges(edges: MemoryEdge[]): MemoryEdge[] {
  const best = new Map<string, MemoryEdge>();
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.type}`;
    const existing = best.get(key);
    if (!existing || edge.weight > existing.weight) best.set(key, edge);
  }
  return [...best.values()];
}

export function validateLoadedGraph(nodes: Map<string, MemoryNode>, edges: MemoryEdge[]): ValidatedGraph {
  const summary: RepairSummary = { phantomEdges: 0, selfLoops: 0, nodeFields: 0, weightsClamped: 0, duplicateEdges: 0 };

  const repairedNodes = new Map<string, MemoryNode>();
  for (const [id, node] of nodes) {
    const { node: fixed, fixes } = repairNode(id, node);
    summary.nodeFields += fixes;
    repairedNodes.set(id, fixed);
  }

  const linked = edges.filter(e => repairedNodes.has(e.from) && repairedNodes.has(e.to));
  summary.phantomEdges = edges.length - linked.length;

  const noLoops = linked.filter(e => e.from !== e.to);
  summary.selfLoops = linked.length - noLoops.length;

  const clamped = noLoops.map(repairEdgeWeight);
  summary.weightsClamped = clamped.filter(c => c.fixed).length;

  const deduped = dedupeEdges(clamped.map(c => c.edge));
  summary.duplicateEdges = clamped.length - deduped.length;

  const repaired = Object.values(summary).some(n => n > 0);
  if (repaired) {
    log(`Graph validation: repairs pending save (${summary.phantomEdges} phantom, ${summary.selfLoops} self-loops, ${summary.nodeFields} node fields, ${summary.weightsClamped} weights clamped, ${summary.duplicateEdges} duplicates removed)`);
  }

  return { nodes: repairedNodes, edges: deduped, repaired, summary };
}
