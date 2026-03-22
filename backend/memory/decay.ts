import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, RetentionTier, WorkingMemory } from "./types.js";
import { extractKeywordsFromText, spreadingActivation } from "./activation.js";
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
import { getBrainConfig } from "../brain-config.js";
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
  // promote it one tier up from standard — but only if the neighbor is strong enough
  const edges = graph.edgesFor(node.id);
  for (const edge of edges) {
    if (edge.type !== "social") continue;
    const otherId = edge.from === node.id ? edge.to : edge.from;
    const other = graph.getNode(otherId);
    if (!other) continue;
    if (other.strength < 0.3) continue; // skip weak/dying neighbors
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

// Activation threshold for archive rescan — archived nodes scoring above this are promoted
const RESCAN_ACTIVATION_THRESHOLD = 0.15;

/**
 * Periodic archive rescan using spreading activation against cold storage.
 *
 * Instead of simple keyword matching, this:
 * 1. Extracts context terms from working memory
 * 2. Runs spreading activation on the active graph to find the current activation pattern
 * 3. Builds activation-weighted terms from the most active nodes
 * 4. Scores each archived node against this weighted pattern
 * 5. Promotes archived nodes whose activation score exceeds threshold
 *
 * This mimics associative recall — contextual triggers reactivate dormant memories
 * through the same spreading activation mechanism used for active recall.
 */
export function rescanArchive(graph: MemoryGraph, wm: WorkingMemory): number {
  if (graph.archiveSize === 0) return 0;

  // Step 1: Build context terms from working memory
  const contextTerms: string[] = [];
  if (wm.currentContext) contextTerms.push(...extractKeywordsFromText(wm.currentContext));
  if (wm.shortTermTracking) {
    for (const item of wm.shortTermTracking) {
      contextTerms.push(...extractKeywordsFromText(item));
    }
  }

  const uniqueContextTerms = [...new Set(contextTerms)].slice(0, 20);
  if (uniqueContextTerms.length === 0) return 0;

  // Step 2: Run spreading activation on active graph to get current activation pattern
  const activated = spreadingActivation(graph, uniqueContextTerms, 15);

  // Step 3: Build activation-weighted term set from activated nodes
  // Terms from highly-activated nodes matter more than terms from weakly-activated ones
  const weightedTerms = new Map<string, number>();

  for (const { node, activation } of activated) {
    const nodeTerms = [
      ...extractKeywordsFromText(node.content),
      ...node.tags.map(t => t.toLowerCase()),
    ];
    for (const term of nodeTerms) {
      const existing = weightedTerms.get(term) || 0;
      weightedTerms.set(term, Math.max(existing, activation));
    }
  }

  // Include direct context terms with base activation weight
  for (const term of uniqueContextTerms) {
    const existing = weightedTerms.get(term) || 0;
    weightedTerms.set(term, Math.max(existing, 0.3));
  }

  if (weightedTerms.size === 0) return 0;

  // Step 4: Score each archived node using activation-weighted matching
  const candidates: { id: string; score: number }[] = [];

  for (const archived of graph.allArchivedNodes()) {
    const contentLower = archived.content.toLowerCase();
    const tagsLower = archived.tags.map(t => t.toLowerCase());

    let score = 0;
    let hits = 0;

    for (const [term, weight] of weightedTerms) {
      if (contentLower.includes(term)) {
        score += 0.3 * weight;
        hits++;
      }
      if (tagsLower.some(t => t.includes(term))) {
        score += 0.5 * weight;
        hits++;
      }
    }

    if (hits === 0) continue;

    // Factor in original node strength and archive recency
    const recencyDays = (Date.now() - archived.archivedAt) / 86400000;
    const recencyBonus = 1 / (1 + recencyDays / 30);
    score *= archived.strength * (1 + recencyBonus);

    if (score >= RESCAN_ACTIVATION_THRESHOLD) {
      candidates.push({ id: archived.id, score });
    }
  }

  // Step 5: Restore top candidates that exceed threshold
  candidates.sort((a, b) => b.score - a.score);

  // Scale restore limit with archive size: larger archives get more restores per cycle
  const cfg = getBrainConfig();
  const divisor = cfg.archiveRecallDivisor > 0 ? cfg.archiveRecallDivisor : 1;
  const scaledRestore = Math.floor(graph.archiveSize / divisor);
  const maxRestore = Math.min(cfg.archiveRecallMax, Math.max(cfg.archiveRecallMin, scaledRestore));

  let restored = 0;
  for (const candidate of candidates.slice(0, maxRestore)) {
    if (graph.restoreNode(candidate.id)) {
      restored++;
    }
  }

  if (restored > 0) {
    log(`Archive rescan: restored ${restored}/${candidates.length} nodes via spreading activation (${weightedTerms.size} weighted terms, threshold ${RESCAN_ACTIVATION_THRESHOLD})`);
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
