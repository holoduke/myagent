import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, RetentionTier } from "./types.js";
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
import { inferValenceFromText } from "../emotion-tracker.js";
import { createLogger } from "../logger.js";

const log = createLogger("decay");

// ── Retention Tier Classification ──

export const TIER_PRIORITY: RetentionTier[] = ["core", "important", "work", "ephemeral", "standard"];

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
export function applyDecay(graph: MemoryGraph, tierCache?: Map<string, RetentionTier>): { decayed: number; pruned: number; prunedIds: string[] } {
  const now = Date.now();
  let decayed = 0;
  let pruned = 0;
  const toPrune: string[] = [];
  const tierCounts: Record<RetentionTier, number> = { core: 0, important: 0, work: 0, standard: 0, ephemeral: 0 };

  for (const node of graph.allNodes()) {
    if (node.pinned) continue;

    // Guard against undefined/NaN lastAccessedAt — reset to now and skip this cycle
    if (!Number.isFinite(node.lastAccessedAt)) {
      log(`NaN guard: node ${node.id} has invalid lastAccessedAt (${node.lastAccessedAt}), resetting to now`);
      node.lastAccessedAt = now;
      continue;
    }

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
    // Importance-based resistance: high-importance nodes decay slower regardless of frequency
    // importance=1.0 → 0.2x decay, importance=0.5 → 0.6x decay, importance=0 → 1.0x (no effect)
    const importanceResistance = node.importance ? (1 - 0.8 * node.importance) : 1;
    // Confidence-based resistance: high-confidence (owner-sourced) facts decay slower than
    // low-confidence (inferred) ones. autoAssignConfidence emits 1.0 owner, 0.7 reported,
    // 0.5 inferred, so we center the multiplier at 0.5 (neutral) with a 0.8 slope.
    // confidence=1.0 → 0.6x, confidence=0.7 → 0.84x, confidence=0.5 → 1.0x, confidence=0.3 → 1.16x.
    // Undefined/null confidence → 1.0x (no effect, treated as unknown).
    const confidenceResistance = (node.confidence !== undefined && node.confidence !== null)
      ? (1.4 - 0.8 * node.confidence)
      : 1;
    // Useless retrieval penalty: nodes repeatedly included in context but never referenced by Claude decay faster
    // Exempt core/important tier nodes and high-importance nodes (>= 0.5) — hub nodes get activated
    // by spreading activation rather than direct reference, so their uselessRetrievalCount climbs
    // artificially, creating a vicious decay cycle for structurally important nodes.
    const exemptFromUselessPenalty = tier === "core" || tier === "important" || (node.importance ?? 0) >= 0.5;
    const uselessPenalty = !exemptFromUselessPenalty && (node.uselessRetrievalCount ?? 0) > 3
      ? 1 + Math.min(1, ((node.uselessRetrievalCount ?? 0) - 3) * 0.25)
      : 1;
    let effectiveLambda = lambda * resistance * tierMultiplier * importanceResistance * confidenceResistance * uselessPenalty;

    // Phase 5a: Temporal fact validity — accelerate decay for expired facts
    if (node.validUntil && node.validUntil < now) {
      effectiveLambda *= 3; // 3x faster decay for expired facts
    }

    // Concept nodes with children decay slower — they're structurally important
    if (node.type === "concept") {
      const childCount = graph.getChildren(node.id).length;
      if (childCount > 0) {
        effectiveLambda *= 0.5;
      }
    }

    const newStrength = node.strength * Math.exp(-effectiveLambda * hoursSinceAccess);
    // Guard against NaN/Infinity propagating into strength
    if (!Number.isFinite(newStrength)) {
      log(`NaN guard: node ${node.id} decay produced ${newStrength} (strength=${node.strength}, lambda=${effectiveLambda}, hours=${hoursSinceAccess}), skipping`);
      continue;
    }
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
  return { decayed, pruned, prunedIds: toPrune };
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
      // One pinned endpoint — decay at 20% rate to preserve important connections.
      // Context disconnection from pinned nodes (identity anchors) causes silent
      // drift that the agent can't detect from the inside. (Moltbook insight, Apr 2026)
      const rate = onePinned ? 0.01 : 0.05;
      edge.weight = edge.weight * (1 - rate) + minStrength * rate;
      decayed++;
    }

    // Floor: edges touching pinned nodes never drop below 0.15
    // This prevents core memories from becoming completely isolated
    if (onePinned && edge.weight < 0.15) {
      edge.weight = 0.15;
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
export const TIER_SORT_PRIORITY: Record<RetentionTier, number> = {
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

// ── Auto-Salience Inference ──

/** Salience signal keywords — emotional language, milestones, decisions */
export const SALIENCE_SIGNALS: { pattern: RegExp; weight: number }[] = [
  // High salience — life events, medical, legal
  { pattern: /\b(ziekenhuis|hospital|dokter|doctor|spoed|emergency|operatie|surgery)\b/i, weight: 0.9 },
  { pattern: /\b(zwanger|pregnant|geboren|born|bevalling|delivery)\b/i, weight: 0.9 },
  { pattern: /\b(overlijden|overleden|died|death|funeral|begrafenis)\b/i, weight: 0.95 },
  { pattern: /\b(trouwen|wedding|huwelijk|married|verloving|engaged)\b/i, weight: 0.85 },
  { pattern: /\b(ontslagen|fired|ontslag|layoff|promotie|promotion)\b/i, weight: 0.8 },

  // Medium-high salience — decisions, agreements, milestones
  { pattern: /\b(besloten|decided|afgesproken|agreed|definitief|final)\b/i, weight: 0.7 },
  { pattern: /\b(eerste keer|first time|voor het eerst|milestone|doorbraak|breakthrough)\b/i, weight: 0.7 },
  { pattern: /\b(deadline|contract|getekend|signed|akkoord|approved)\b/i, weight: 0.65 },
  { pattern: /\b(verhuizen|moving|moved|nieuw huis|new house)\b/i, weight: 0.65 },

  // Medium salience — emotional intensity markers
  { pattern: /!!+/i, weight: 0.4 },
  { pattern: /\b(heel erg|super|amazing|incredible|ongelofelijk|geweldig|fantastic)\b/i, weight: 0.35 },
  { pattern: /\b(sorry|excuses|spijt|regret|boos|angry|verdrietig|sad|huilen|crying)\b/i, weight: 0.5 },
  { pattern: /\b(trots|proud|gefeliciteerd|congratulations|feest|celebration)\b/i, weight: 0.45 },

  // Lower salience — plans, appointments
  { pattern: /\b(afspraak|appointment|vergadering|meeting|planning)\b/i, weight: 0.3 },
  { pattern: /\b(morgen|tomorrow|volgende week|next week|vandaag|today)\b/i, weight: 0.2 },
];

/**
 * Infer content salience from text — returns 0.0-1.0 score based on
 * emotional language, milestone keywords, and decision signals.
 *
 * This addresses the frequency bias problem: important one-off events
 * (medical decisions, milestones, key conversations) often don't repeat
 * but should be preserved. Salience scoring catches what frequency misses.
 */
export function inferContentSalience(text: string): number {
  let maxWeight = 0;
  let hitCount = 0;

  for (const { pattern, weight } of SALIENCE_SIGNALS) {
    if (pattern.test(text)) {
      maxWeight = Math.max(maxWeight, weight);
      hitCount++;
    }
  }

  if (hitCount === 0) return 0;

  // Score is dominated by the strongest signal, with a small bonus for multiple signals
  const multiSignalBonus = Math.min(0.15, (hitCount - 1) * 0.05);
  return Math.min(1, maxWeight + multiSignalBonus);
}

/**
 * Auto-apply salience to nodes during decay pass.
 * Scans nodes that have no explicit importance set and infers it from content.
 * Only sets importance for nodes scoring above threshold — avoids noise.
 * Also infers emotional valence for nodes without it.
 */
export function autoInferSalience(graph: MemoryGraph, threshold = 0.25): number {
  let updated = 0;

  for (const node of graph.allNodes()) {
    // Skip pinned nodes — they don't need decay protection
    if (node.pinned) continue;

    // Importance inference
    if (node.importance === null || node.importance === undefined || node.importance === 0) {
      const salience = inferContentSalience(node.content);
      if (salience >= threshold) {
        node.importance = salience;
        updated++;
      }
    }

    // Emotional valence inference (separate concern, always infer if missing)
    if (node.emotionalValence === undefined || node.emotionalValence === null) {
      const valence = inferEmotionalValence(node.content);
      if (valence !== 0) {
        node.emotionalValence = valence;
      }
    }
  }

  if (updated > 0) {
    log(`Auto-salience: set importance on ${updated} nodes`);
  }

  return updated;
}

// ── Emotional Valence Inference ──
// Delegates to the shared inferValenceFromText in emotion-tracker.ts
// to avoid maintaining duplicate emotion patterns.

/**
 * Infer emotional direction from text content.
 * Returns -1.0 (strongly negative) to 1.0 (strongly positive), 0 for neutral.
 */
export function inferEmotionalValence(text: string): number {
  return inferValenceFromText(text);
}

// ── Spaced Repetition Refresh ──

/**
 * Boost high-importance but declining-strength nodes.
 * Prevents important one-off memories from fading when they haven't been
 * reinforced through repeated access. Based on spaced repetition research:
 * periodic small boosts are more effective than letting memories fully decay.
 */
export function spacedRepetitionRefresh(graph: MemoryGraph): number {
  let refreshed = 0;

  for (const node of graph.allNodes()) {
    if (node.pinned) continue;
    const importance = node.importance ?? 0;
    if (importance < 0.6) continue;
    if (node.strength >= 0.4) continue;

    // Boost strength toward importance level, capped at importance * 0.8
    const ceiling = importance * 0.8;
    const boost = Math.min(0.1, ceiling - node.strength);
    if (boost <= 0) continue;

    node.strength = Math.min(ceiling, node.strength + boost);
    node.lastAccessedAt = Date.now();
    refreshed++;
  }

  if (refreshed > 0) {
    log(`Spaced repetition: refreshed ${refreshed} high-importance declining nodes`);
  }

  return refreshed;
}

// ── Rejected-Edge Pruning ──

/**
 * Prune stale or dangling rejected-edge entries.
 * Delegates to the graph (which owns the storage); kept here so it slots into
 * the consolidation pipeline alongside the other decay/prune steps.
 */
export function pruneRejectedEdges(graph: MemoryGraph): number {
  return graph.pruneRejectedEdges();
}

// ── Auto-Confidence Assignment ──

/**
 * Assign confidence scores to nodes based on source signals in their tags.
 * Owner-sourced content gets highest confidence; inferences get lowest.
 * Only sets confidence on nodes that don't already have it.
 */
export function autoAssignConfidence(graph: MemoryGraph): number {
  let updated = 0;

  for (const node of graph.allNodes()) {
    if (node.confidence !== undefined && node.confidence !== null) continue;

    const tagsLower = new Set(node.tags.map(t => t.toLowerCase()));

    if (tagsLower.has("owner") || tagsLower.has("gillis") || tagsLower.has("gillis-family")) {
      node.confidence = 1.0;
    } else if (tagsLower.has("whitelisted") || tagsLower.has("family") || tagsLower.has("friend")) {
      node.confidence = 0.8;
    } else if (tagsLower.has("work") || tagsLower.has("colleague") || tagsLower.has("professional-life")) {
      node.confidence = 0.7;
    } else if (node.type === "insight" || node.type === "meta") {
      node.confidence = 0.5;
    } else if (node.type === "event" || node.type === "fact" || node.type === "person") {
      node.confidence = 0.6;
    } else {
      node.confidence = 0.5;
    }

    updated++;
  }

  if (updated > 0) {
    log(`Auto-confidence: assigned confidence to ${updated} nodes`);
  }

  return updated;
}
