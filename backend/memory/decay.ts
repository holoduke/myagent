import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, RetentionTier, WorkingMemory } from "./types.js";
import { extractKeywordsFromText } from "./activation.js";
import {
  DECAY_LAMBDA,
  PRUNE_NODE_THRESHOLD,
  PRUNE_EDGE_THRESHOLD,
  ORPHAN_GRACE_HOURS,
  MAX_NODES_HARD,
  RETENTION_MULTIPLIER,
  TIER_TAG_SIGNALS,
  TIER_CONTENT_SIGNALS,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("decay");

// ── Retention Tier Classification ──

const TIER_PRIORITY: RetentionTier[] = ["core", "important", "work", "ephemeral", "standard"];

/**
 * Classify a node into a retention tier based on its tags, content, and connections.
 * Checks from highest priority (core) to lowest (ephemeral).
 * Falls back to "standard" if no signals match.
 */
export function classifyRetentionTier(node: MemoryNode, graph: MemoryGraph): RetentionTier {
  const tagsLower = new Set(node.tags.map(t => t.toLowerCase().replace(/^#/, "")));
  const contentLower = node.content.toLowerCase();

  // Check tag signals (highest tier wins)
  for (const tier of TIER_PRIORITY) {
    const tagSignals = TIER_TAG_SIGNALS[tier];
    if (tagSignals.length === 0) continue;
    for (const signal of tagSignals) {
      if (tagsLower.has(signal.toLowerCase())) return tier;
    }
  }

  // Check content signals
  for (const tier of TIER_PRIORITY) {
    const contentSignals = TIER_CONTENT_SIGNALS[tier];
    if (contentSignals.length === 0) continue;
    for (const signal of contentSignals) {
      if (contentLower.includes(signal.toLowerCase())) return tier;
    }
  }

  // Connection-based promotion: if a node has social edges to core/important nodes,
  // promote it one tier up from standard
  const edges = graph.edgesFor(node.id);
  for (const edge of edges) {
    if (edge.type !== "social") continue;
    const otherId = edge.from === node.id ? edge.to : edge.from;
    const other = graph.getNode(otherId);
    if (!other) continue;
    const otherTags = new Set(other.tags.map(t => t.toLowerCase().replace(/^#/, "")));
    const coreSignals = TIER_TAG_SIGNALS.core;
    for (const signal of coreSignals) {
      if (otherTags.has(signal.toLowerCase())) return "important";
    }
  }

  return "standard";
}

/**
 * Apply exponential decay to all unpinned nodes.
 * strength = strength * e^(-lambda * hours)
 * Nodes with high accessCount decay slower (logarithmic resistance).
 * Retention tier applies a multiplier to the decay rate.
 */
export function applyDecay(graph: MemoryGraph, tierCache?: Map<string, RetentionTier>): { decayed: number; pruned: number } {
  const now = Date.now();
  let decayed = 0;
  let pruned = 0;
  const toPrune: string[] = [];
  const tierCounts: Record<RetentionTier, number> = { core: 0, important: 0, work: 0, standard: 0, ephemeral: 0 };

  for (const node of graph.allNodes()) {
    if (node.pinned) continue;

    const hoursSinceAccess = Math.max(0, (now - node.lastAccessedAt) / 3600000);
    if (hoursSinceAccess === 0) continue;

    // Classify retention tier (populate cache if provided)
    const tier = tierCache?.get(node.id) ?? classifyRetentionTier(node, graph);
    if (tierCache) tierCache.set(node.id, tier);
    tierCounts[tier]++;
    const tierMultiplier = RETENTION_MULTIPLIER[tier];

    const lambda = DECAY_LAMBDA[node.type] ?? 0.004;
    // Logarithmic resistance: more accesses = slower decay
    const resistance = 1 / (1 + Math.log2(1 + node.accessCount));
    let effectiveLambda = lambda * resistance * tierMultiplier;

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

  // Archive weak nodes (move to long-term cold storage instead of deleting)
  for (const id of toPrune) {
    graph.archiveNode(id, "decay");
    pruned++;
  }

  log(`Decay pass: ${decayed} decayed, ${pruned} archived | tiers: core=${tierCounts.core} important=${tierCounts.important} work=${tierCounts.work} standard=${tierCounts.standard} ephemeral=${tierCounts.ephemeral}`);
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

    // Protect edges between pinned nodes from decay
    const bothPinned = fromNode.pinned && toNode.pinned;
    const onePinned = fromNode.pinned || toNode.pinned;

    if (bothPinned) {
      // Both endpoints pinned — skip decay entirely (core memory link)
      continue;
    }

    // Edge weight drifts toward the weaker endpoint
    const minStrength = Math.min(fromNode.strength, toNode.strength);
    if (edge.weight > minStrength) {
      // One pinned endpoint — decay at 50% rate to preserve important connections
      const rate = onePinned ? 0.025 : 0.05;
      edge.weight = edge.weight * (1 - rate) + minStrength * rate;
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

    graph.archiveNode(node.id, "orphan");
    pruned++;
  }

  if (pruned > 0) {
    log(`Orphan pruning: ${pruned} orphan nodes archived`);
  }
  return pruned;
}

// Numeric priority for sorting: lower = more protected
const TIER_SORT_PRIORITY: Record<RetentionTier, number> = {
  core: 0,
  important: 1,
  work: 2,
  standard: 3,
  ephemeral: 4,
};

/**
 * Emergency pruning when node count exceeds hard limit.
 * Removes weakest non-pinned nodes, but respects retention tiers:
 * ephemeral nodes are pruned first, then standard, then work, etc.
 */
export function emergencyPrune(graph: MemoryGraph, softLimit: number, tierCache?: Map<string, RetentionTier>): number {
  const count = graph.nodeCount;
  if (count <= MAX_NODES_HARD) return 0;

  const nodes = graph.allNodes()
    .filter(n => !n.pinned)
    .map(n => ({ node: n, tier: tierCache?.get(n.id) ?? classifyRetentionTier(n, graph) }))
    .sort((a, b) => {
      // Sort by tier priority descending (ephemeral first), then by strength ascending
      const tierDiff = TIER_SORT_PRIORITY[b.tier] - TIER_SORT_PRIORITY[a.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.node.strength - b.node.strength;
    });

  let pruned = 0;
  const target = softLimit;
  for (const { node } of nodes) {
    if (graph.nodeCount <= target) break;
    graph.archiveNode(node.id, "emergency");
    pruned++;
  }

  log(`Emergency prune: archived ${pruned} weakest nodes (was ${count}, now ${graph.nodeCount})`);
  return pruned;
}

/**
 * Periodic archive rescan — extract themes from working memory + strongest active nodes,
 * sweep the archive for matches, and restore anything that connects to current context.
 * Like the subconscious surfacing a forgotten memory because something triggered it.
 */
export function rescanArchive(graph: MemoryGraph, wm: WorkingMemory): number {
  if (graph.archiveSize === 0) return 0;

  // Build search terms from current active context
  const themes: string[] = [];

  // From working memory context + mood + tracking
  if (wm.currentContext) themes.push(...extractKeywordsFromText(wm.currentContext));
  if (wm.shortTermTracking) {
    for (const item of wm.shortTermTracking) {
      themes.push(...extractKeywordsFromText(item));
    }
  }

  // From strongest active nodes (top 10 by strength)
  const strongestNodes = graph.allNodes()
    .filter(n => !n.pinned)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 10);

  for (const node of strongestNodes) {
    themes.push(...extractKeywordsFromText(node.content));
    themes.push(...node.tags.map(t => t.toLowerCase()));
  }

  // Deduplicate and take top terms
  const uniqueTerms = [...new Set(themes)].slice(0, 20);
  if (uniqueTerms.length === 0) return 0;

  const query = uniqueTerms.join(" ");
  const candidates = graph.searchArchive(query, 3); // conservative — max 3 per cycle

  let restored = 0;
  for (const candidate of candidates) {
    if (graph.restoreNode(candidate.id)) {
      restored++;
    }
  }

  if (restored > 0) {
    log(`Archive rescan: restored ${restored} nodes from cold storage (matched ${uniqueTerms.length} active themes)`);
  }

  return restored;
}

/**
 * Full consolidation pass: decay → edge decay → orphan prune → emergency prune → archive rescan.
 */
export function runConsolidation(graph: MemoryGraph, wm?: WorkingMemory): {
  nodesDecayed: number;
  nodesPruned: number;
  edgesDecayed: number;
  edgesPruned: number;
  orphansPruned: number;
  emergencyPruned: number;
  archiveRestored: number;
} {
  const tierCache = new Map<string, RetentionTier>();
  const nodeResult = applyDecay(graph, tierCache);
  const edgeResult = applyEdgeDecay(graph);
  const orphansPruned = pruneOrphans(graph);
  const emergencyPruned = emergencyPrune(graph, 500, tierCache);

  // Periodic archive rescan — check if any archived memories match current context
  const archiveRestored = wm ? rescanArchive(graph, wm) : 0;

  return {
    nodesDecayed: nodeResult.decayed,
    nodesPruned: nodeResult.pruned,
    edgesDecayed: edgeResult.decayed,
    edgesPruned: edgeResult.pruned,
    orphansPruned,
    emergencyPruned,
    archiveRestored,
  };
}
