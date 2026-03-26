import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { dirname } from "path";
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
    // Importance-based resistance: high-importance nodes decay slower regardless of frequency
    // importance=1.0 → 0.2x decay, importance=0.5 → 0.6x decay, importance=0 → 1.0x (no effect)
    const importanceResistance = node.importance ? (1 - 0.8 * node.importance) : 1;
    let effectiveLambda = lambda * resistance * tierMultiplier * importanceResistance;

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

// ── Consolidation Health Log ──

const CONSOLIDATION_LOG_PATH = "/data/brain/consolidation-log.jsonl";
const CONSOLIDATION_LOG_MAX_ENTRIES = 500;

interface ConsolidationLogEntry {
  timestamp: string;
  nodeCount: number;
  edgeCount: number;
  archiveSize: number;
  tierDistribution: Record<RetentionTier, number>;
  nodesDecayed: number;
  nodesPruned: number;
  edgesDecayed: number;
  edgesPruned: number;
  orphansPruned: number;
  emergencyPruned: number;
  archiveRestored: number;
  lossRate?: number;         // fraction of nodes lost since last snapshot
  uncapturedCount?: number;  // signals found in logs but not in graph
}

function appendConsolidationLog(entry: ConsolidationLogEntry): void {
  try {
    const dir = dirname(CONSOLIDATION_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    appendFileSync(CONSOLIDATION_LOG_PATH, JSON.stringify(entry) + "\n");

    // Rolling cap: trim to last CONSOLIDATION_LOG_MAX_ENTRIES lines
    if (existsSync(CONSOLIDATION_LOG_PATH)) {
      const content = readFileSync(CONSOLIDATION_LOG_PATH, "utf-8");
      const lines = content.trimEnd().split("\n");
      if (lines.length > CONSOLIDATION_LOG_MAX_ENTRIES) {
        const trimmed = lines.slice(lines.length - CONSOLIDATION_LOG_MAX_ENTRIES);
        writeFileSync(CONSOLIDATION_LOG_PATH, trimmed.join("\n") + "\n");
      }
    }
  } catch (err) {
    log(`Failed to write consolidation log: ${err}`);
  }
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
  uncapturedSignals: UncapturedSignal[];
  deltaReport: DeltaReport | null;
} {
  const tierCache = new Map<string, RetentionTier>();
  const nodeResult = applyDecay(graph, tierCache);
  const edgeResult = applyEdgeDecay(graph);
  const orphansPruned = pruneOrphans(graph);
  const emergencyPruned = emergencyPrune(graph, 500, tierCache);

  // Periodic archive rescan — check if any archived memories match current context
  const archiveRestored = wm ? rescanArchive(graph, wm) : 0;

  // Log audit — scan observations for uncaptured signals
  const uncapturedSignals = auditObservationLogs(graph, 24);

  // Graph snapshot — save current state for future delta comparison
  saveGraphSnapshot(graph);

  // Delta audit — compare current state with ~24h ago snapshot
  const deltaReport = compareWithSnapshot(graph, 24);

  // Build tier distribution from cache
  const tierDistribution: Record<RetentionTier, number> = { core: 0, important: 0, work: 0, standard: 0, ephemeral: 0 };
  for (const tier of tierCache.values()) {
    tierDistribution[tier]++;
  }

  const result = {
    nodesDecayed: nodeResult.decayed,
    nodesPruned: nodeResult.pruned,
    edgesDecayed: edgeResult.decayed,
    edgesPruned: edgeResult.pruned,
    orphansPruned,
    emergencyPruned,
    archiveRestored,
    uncapturedSignals,
    deltaReport,
  };

  // Append health metrics to consolidation log
  appendConsolidationLog({
    timestamp: new Date().toISOString(),
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    archiveSize: graph.archiveSize,
    tierDistribution,
    nodesDecayed: result.nodesDecayed,
    nodesPruned: result.nodesPruned,
    edgesDecayed: result.edgesDecayed,
    edgesPruned: result.edgesPruned,
    orphansPruned: result.orphansPruned,
    emergencyPruned: result.emergencyPruned,
    archiveRestored: result.archiveRestored,
    lossRate: deltaReport?.lossRate,
    uncapturedCount: uncapturedSignals.length,
  });

  return result;
}

// ── Observation Log Audit ──

const OBSERVATIONS_FILE = `${process.env.BRAIN_DIR || "/data/brain"}/observations.jsonl`;

interface ObservationLogEntry {
  timestamp: number;
  sender: string;
  senderJid: string;
  isGroup: boolean;
  groupName?: string;
  isFromMe: boolean;
  text: string;
  source?: string;
}

export interface UncapturedSignal {
  type: "person" | "event" | "topic";
  name: string;
  mentions: number;
  lastSeen: number;
  sampleText: string;
}

/**
 * Audit observation logs for significant signals that may not have corresponding memory nodes.
 *
 * Scans recent observations (last N hours) and extracts:
 * - People mentioned frequently who don't have person nodes
 * - Significant events (decisions, plans, milestones) with no corresponding event/fact nodes
 *
 * Returns uncaptured signals that Claude should consider creating nodes for.
 */
export function auditObservationLogs(graph: MemoryGraph, hoursBack = 24, maxSignals = 10): UncapturedSignal[] {
  if (!existsSync(OBSERVATIONS_FILE)) return [];

  const cutoff = Date.now() - hoursBack * 3600000;
  const lines = readFileSync(OBSERVATIONS_FILE, "utf-8").trimEnd().split("\n");

  // Parse recent observations
  const recent: ObservationLogEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as ObservationLogEntry;
      if (entry.timestamp < cutoff) break; // logs are chronological
      recent.push(entry);
    } catch { /* skip malformed */ }
  }

  if (recent.length === 0) return [];

  // Count sender mentions (non-Gillis, non-bot senders)
  const senderCounts = new Map<string, { count: number; jid: string; lastSeen: number; sample: string }>();
  for (const obs of recent) {
    if (obs.isFromMe) continue;
    if (!obs.sender || obs.sender === "unknown") continue;
    const existing = senderCounts.get(obs.sender);
    if (existing) {
      existing.count++;
      if (obs.timestamp > existing.lastSeen) {
        existing.lastSeen = obs.timestamp;
        existing.sample = obs.text.slice(0, 120);
      }
    } else {
      senderCounts.set(obs.sender, {
        count: 1,
        jid: obs.senderJid,
        lastSeen: obs.timestamp,
        sample: obs.text.slice(0, 120),
      });
    }
  }

  // Find senders with no person node
  const uncaptured: UncapturedSignal[] = [];
  const personNodes = graph.findByType("person");
  const knownNames = new Set(personNodes.map(n => n.content.toLowerCase()));
  const knownTags = new Set(personNodes.flatMap(n => n.tags.map(t => t.toLowerCase())));

  for (const [name, data] of senderCounts) {
    if (data.count < 2) continue; // need at least 2 messages to be signal
    const nameLower = name.toLowerCase();
    // Check if this person already has a node (by name in content or tags)
    const hasNode = knownNames.has(nameLower)
      || [...knownNames].some(n => n.includes(nameLower))
      || knownTags.has(nameLower);
    if (hasNode) continue;

    uncaptured.push({
      type: "person",
      name,
      mentions: data.count,
      lastSeen: data.lastSeen,
      sampleText: data.sample,
    });
  }

  // Detect high-signal event keywords in recent messages
  const eventSignals = [
    "decided", "besloten", "afgesproken", "agreed", "deadline", "appointment",
    "doctor", "dokter", "school", "hospital", "ziekenhuis", "moving", "verhuizen",
    "pregnant", "zwanger", "promotion", "fired", "ontslagen", "accident", "ongeluk",
    "birthday", "verjaardag", "wedding", "trouwen", "funeral", "begrafenis",
  ];
  const eventHits = new Map<string, { count: number; lastSeen: number; sample: string }>();
  for (const obs of recent) {
    const textLower = obs.text.toLowerCase();
    for (const signal of eventSignals) {
      if (textLower.includes(signal)) {
        const existing = eventHits.get(signal);
        if (existing) {
          existing.count++;
          if (obs.timestamp > existing.lastSeen) {
            existing.lastSeen = obs.timestamp;
            existing.sample = obs.text.slice(0, 120);
          }
        } else {
          eventHits.set(signal, { count: 1, lastSeen: obs.timestamp, sample: obs.text.slice(0, 120) });
        }
      }
    }
  }

  // Only surface event signals mentioned 2+ times (repeated = more likely significant)
  for (const [keyword, data] of eventHits) {
    if (data.count < 2) continue;
    uncaptured.push({
      type: "event",
      name: keyword,
      mentions: data.count,
      lastSeen: data.lastSeen,
      sampleText: data.sample,
    });
  }

  // Sort by mention count descending, cap at maxSignals
  uncaptured.sort((a, b) => b.mentions - a.mentions);
  const result = uncaptured.slice(0, maxSignals);

  if (result.length > 0) {
    log(`Log audit: found ${result.length} uncaptured signals in last ${hoursBack}h (${recent.length} observations scanned)`);
  }

  return result;
}

// ── Graph Snapshots & Delta Audit ──

const SNAPSHOT_DIR = `${process.env.BRAIN_DIR || "/data/brain"}/graph/snapshots`;
const MAX_SNAPSHOTS = 50;

export interface GraphSnapshot {
  timestamp: number;
  nodeCount: number;
  edgeCount: number;
  archiveSize: number;
  nodeIds: string[];
  nodeStrengths: Record<string, number>;
  nodeTypes: Record<string, string>;
}

export interface DeltaReport {
  snapshotAge: number;        // hours since snapshot
  nodesLost: string[];        // IDs in snapshot but not in current graph
  nodesGained: string[];      // IDs in current graph but not in snapshot
  nodesWeakened: { id: string; was: number; now: number }[];  // strength decreased
  nodesStrengthened: { id: string; was: number; now: number }[];
  lossRate: number;           // fraction of snapshot nodes that are gone (0-1)
  summary: string;
}

/**
 * Save a lightweight snapshot of the current graph state.
 * Called during consolidation to enable future delta audits.
 */
export function saveGraphSnapshot(graph: MemoryGraph): void {
  if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const now = Date.now();
  const nodes = graph.allNodes();
  const snapshot: GraphSnapshot = {
    timestamp: now,
    nodeCount: nodes.length,
    edgeCount: graph.edgeCount,
    archiveSize: graph.archiveSize,
    nodeIds: nodes.map(n => n.id),
    nodeStrengths: Object.fromEntries(nodes.map(n => [n.id, Math.round(n.strength * 1000) / 1000])),
    nodeTypes: Object.fromEntries(nodes.map(n => [n.id, n.type])),
  };

  const filename = `${SNAPSHOT_DIR}/snapshot_${now}.json`;
  writeFileSync(filename, JSON.stringify(snapshot));

  // Prune old snapshots (keep MAX_SNAPSHOTS most recent)
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter(f => f.startsWith("snapshot_") && f.endsWith(".json"))
      .sort();
    if (files.length > MAX_SNAPSHOTS) {
      const toDelete = files.slice(0, files.length - MAX_SNAPSHOTS);
      for (const f of toDelete) {
        unlinkSync(`${SNAPSHOT_DIR}/${f}`);
      }
    }
  } catch { /* ignore cleanup errors */ }

  log(`Graph snapshot saved: ${nodes.length} nodes, ${graph.edgeCount} edges`);
}

/**
 * Compare current graph against a past snapshot to measure memory loss.
 * Returns a delta report showing what was lost, gained, weakened, strengthened.
 */
export function compareWithSnapshot(graph: MemoryGraph, hoursBack = 24): DeltaReport | null {
  if (!existsSync(SNAPSHOT_DIR)) return null;

  // Find the snapshot closest to hoursBack ago
  const targetTime = Date.now() - hoursBack * 3600000;
  let bestFile: string | null = null;
  let bestDist = Infinity;

  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter(f => f.startsWith("snapshot_") && f.endsWith(".json"));

    for (const f of files) {
      const ts = parseInt(f.replace("snapshot_", "").replace(".json", ""), 10);
      if (isNaN(ts)) continue;
      const dist = Math.abs(ts - targetTime);
      if (dist < bestDist) {
        bestDist = dist;
        bestFile = f;
      }
    }
  } catch { return null; }

  if (!bestFile) return null;

  let snapshot: GraphSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(`${SNAPSHOT_DIR}/${bestFile}`, "utf-8"));
  } catch { return null; }

  const currentIds = new Set(graph.allNodes().map(n => n.id));
  const snapshotIds = new Set(snapshot.nodeIds);

  const nodesLost = snapshot.nodeIds.filter(id => !currentIds.has(id));
  const nodesGained = graph.allNodes().filter(n => !snapshotIds.has(n.id)).map(n => n.id);
  const nodesWeakened: DeltaReport["nodesWeakened"] = [];
  const nodesStrengthened: DeltaReport["nodesStrengthened"] = [];

  for (const id of snapshot.nodeIds) {
    const current = graph.getNode(id);
    if (!current) continue;
    const was = snapshot.nodeStrengths[id] ?? 0;
    const now = Math.round(current.strength * 1000) / 1000;
    const diff = now - was;
    if (diff < -0.05) nodesWeakened.push({ id, was, now });
    else if (diff > 0.05) nodesStrengthened.push({ id, was, now });
  }

  const lossRate = snapshot.nodeIds.length > 0 ? nodesLost.length / snapshot.nodeIds.length : 0;
  const snapshotAge = (Date.now() - snapshot.timestamp) / 3600000;

  const summary = `Delta audit (${snapshotAge.toFixed(1)}h ago): ${nodesLost.length} lost, ${nodesGained.length} gained, ${nodesWeakened.length} weakened, ${nodesStrengthened.length} strengthened. Loss rate: ${(lossRate * 100).toFixed(1)}%`;
  log(summary);

  return {
    snapshotAge,
    nodesLost,
    nodesGained,
    nodesWeakened,
    nodesStrengthened,
    lossRate,
    summary,
  };
}
