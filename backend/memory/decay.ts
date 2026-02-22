import { appendFileSync } from "fs";
import type { MemoryGraph } from "./graph.js";
import {
  DECAY_LAMBDA,
  PRUNE_NODE_THRESHOLD,
  PRUNE_EDGE_THRESHOLD,
  ORPHAN_GRACE_HOURS,
  MAX_NODES_HARD,
} from "./types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [decay] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

/**
 * Apply exponential decay to all unpinned nodes.
 * strength = strength * e^(-lambda * hours)
 * Nodes with high accessCount decay slower (logarithmic resistance).
 */
export function applyDecay(graph: MemoryGraph): { decayed: number; pruned: number } {
  const now = Date.now();
  let decayed = 0;
  let pruned = 0;
  const toPrune: string[] = [];

  for (const node of graph.allNodes()) {
    if (node.pinned) continue;

    const hoursSinceAccess = (now - node.lastAccessedAt) / 3600000;
    if (hoursSinceAccess <= 0) continue;

    const lambda = DECAY_LAMBDA[node.type] ?? 0.004;
    // Logarithmic resistance: more accesses = slower decay
    const resistance = 1 / (1 + Math.log2(1 + node.accessCount));
    let effectiveLambda = lambda * resistance;

    // Concept nodes with children decay slower — they're structurally important
    if (node.type === "concept") {
      const childCount = graph.getChildren(node.id).length;
      if (childCount > 0) {
        effectiveLambda *= 0.5;
      }
    }

    const newStrength = node.strength * Math.exp(-effectiveLambda * hoursSinceAccess);
    if (newStrength !== node.strength) {
      node.strength = Math.max(0, newStrength);
      decayed++;
    }

    if (node.strength < PRUNE_NODE_THRESHOLD) {
      toPrune.push(node.id);
    }
  }

  // Prune weak nodes
  for (const id of toPrune) {
    graph.removeNode(id);
    pruned++;
  }

  log(`Decay pass: ${decayed} nodes decayed, ${pruned} pruned (below ${PRUNE_NODE_THRESHOLD})`);
  return { decayed, pruned };
}

/**
 * Decay edge weights — pulled toward weaker endpoint.
 * Prune edges below threshold.
 */
export function applyEdgeDecay(graph: MemoryGraph): { decayed: number; pruned: number } {
  let decayed = 0;
  let pruned = 0;
  const toRemove: { from: string; to: string }[] = [];

  for (const edge of graph.allEdges()) {
    const fromNode = graph.getNode(edge.from);
    const toNode = graph.getNode(edge.to);
    if (!fromNode || !toNode) {
      toRemove.push({ from: edge.from, to: edge.to });
      continue;
    }

    // Edge weight drifts toward the weaker endpoint
    const minStrength = Math.min(fromNode.strength, toNode.strength);
    if (edge.weight > minStrength) {
      edge.weight = edge.weight * 0.95 + minStrength * 0.05;
      decayed++;
    }

    if (edge.weight < PRUNE_EDGE_THRESHOLD) {
      toRemove.push({ from: edge.from, to: edge.to });
    }
  }

  for (const { from, to } of toRemove) {
    graph.removeEdge(from, to);
    pruned++;
  }

  log(`Edge decay: ${decayed} decayed, ${pruned} pruned (below ${PRUNE_EDGE_THRESHOLD})`);
  return { decayed, pruned };
}

/**
 * Prune orphan nodes (no edges) that have existed beyond grace period.
 */
export function pruneOrphans(graph: MemoryGraph): number {
  const now = Date.now();
  const graceMs = ORPHAN_GRACE_HOURS * 3600000;
  let pruned = 0;

  for (const node of graph.allNodes()) {
    if (node.pinned) continue;
    const edges = graph.edgesFor(node.id);
    if (edges.length > 0) continue;
    // Skip concept nodes with children — they're not truly orphaned
    if (node.type === "concept" && graph.getChildren(node.id).length > 0) continue;
    if (now - node.createdAt < graceMs) continue;

    graph.removeNode(node.id);
    pruned++;
  }

  if (pruned > 0) {
    log(`Orphan pruning: ${pruned} orphan nodes removed`);
  }
  return pruned;
}

/**
 * Emergency pruning when node count exceeds hard limit.
 * Removes weakest non-pinned nodes until under soft limit.
 */
export function emergencyPrune(graph: MemoryGraph, softLimit: number): number {
  const count = graph.nodeCount;
  if (count <= MAX_NODES_HARD) return 0;

  const nodes = graph.allNodes()
    .filter(n => !n.pinned)
    .sort((a, b) => a.strength - b.strength);

  let pruned = 0;
  const target = softLimit;
  for (const node of nodes) {
    if (graph.nodeCount <= target) break;
    graph.removeNode(node.id);
    pruned++;
  }

  log(`Emergency prune: removed ${pruned} weakest nodes (was ${count}, now ${graph.nodeCount})`);
  return pruned;
}

/**
 * Full consolidation pass: decay → edge decay → orphan prune → emergency prune.
 */
export function runConsolidation(graph: MemoryGraph): {
  nodesDecayed: number;
  nodesPruned: number;
  edgesDecayed: number;
  edgesPruned: number;
  orphansPruned: number;
  emergencyPruned: number;
} {
  const nodeResult = applyDecay(graph);
  const edgeResult = applyEdgeDecay(graph);
  const orphansPruned = pruneOrphans(graph);
  const emergencyPruned = emergencyPrune(graph, 500);

  return {
    nodesDecayed: nodeResult.decayed,
    nodesPruned: nodeResult.pruned,
    edgesDecayed: edgeResult.decayed,
    edgesPruned: edgeResult.pruned,
    orphansPruned,
    emergencyPruned,
  };
}
