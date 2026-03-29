import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { dirname } from "path";
import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, WorkingMemory } from "./types.js";
import { extractKeywordsFromText, spreadingActivation } from "./activation.js";
import { getBrainConfig } from "../brain-config.js";
import { createLogger } from "../logger.js";
import { inferContentSalience } from "./retention.js";

const log = createLogger("decay");

// ── Archive Rescan ──

// Activation threshold for archive rescan — archived nodes scoring above this are promoted
export const RESCAN_ACTIVATION_THRESHOLD = 0.15;

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

// ── Observation Log Audit ──

const OBSERVATIONS_FILE = `${process.env.BRAIN_DIR || "/data/brain"}/observations.jsonl`;

export interface ObservationLogEntry {
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

export const SNAPSHOT_DIR = `${process.env.BRAIN_DIR || "/data/brain"}/graph/snapshots`;
export const MAX_SNAPSHOTS = 50;

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

// ── Proactive Log-Based Reconstruction ──

/**
 * The core insight from the Moltbook post: "what important things might have
 * decayed that I should reconstruct from logs before they're gone too?"
 *
 * When nodes are archived during decay, this function searches observation logs
 * for content related to those specific nodes and restores them with enriched
 * context from the raw logs. This addresses the invisible gap problem — memories
 * that decay due to low frequency but were actually significant.
 *
 * Unlike rescanArchive (which restores based on current context relevance),
 * this specifically targets recently-decayed nodes and asks: "was this actually
 * important based on the original observation context?"
 */
export function reconstructFromLogs(
  graph: MemoryGraph,
  recentlyArchivedIds: string[],
  logHoursBack = 48,
  maxReconstruct = 5,
): number {
  if (recentlyArchivedIds.length === 0) return 0;
  if (!existsSync(OBSERVATIONS_FILE)) return 0;

  const cutoff = Date.now() - logHoursBack * 3600000;
  const lines = readFileSync(OBSERVATIONS_FILE, "utf-8").trimEnd().split("\n");

  // Parse recent observations
  const recentObs: ObservationLogEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as ObservationLogEntry;
      if (entry.timestamp < cutoff) break;
      recentObs.push(entry);
    } catch { /* skip malformed */ }
  }

  if (recentObs.length === 0) return 0;

  // For each recently archived node, search logs for related content
  const candidates: { id: string; score: number; logMatches: number; salience: number }[] = [];

  for (const id of recentlyArchivedIds) {
    const archived = graph.getArchived(id);
    if (!archived) continue;
    if (archived.pinned) continue; // shouldn't happen, but guard

    // Extract search terms from the archived node
    const terms = extractKeywordsFromText(archived.content);
    const tagTerms = archived.tags.map(t => t.toLowerCase().replace(/^#/, ""));
    const allTerms = [...new Set([...terms, ...tagTerms])];

    if (allTerms.length === 0) continue;

    // Score against observation logs
    let logMatches = 0;
    let totalSalience = 0;

    for (const obs of recentObs) {
      const textLower = obs.text.toLowerCase();
      let matchCount = 0;
      for (const term of allTerms) {
        if (term.length >= 3 && textLower.includes(term)) matchCount++;
      }
      if (matchCount >= 2) { // need at least 2 term matches to count
        logMatches++;
        // Compute salience of matching observation
        totalSalience += inferContentSalience(obs.text);
      }
    }

    if (logMatches === 0) continue;

    // Score: combines log evidence strength with content salience
    const score = (logMatches / recentObs.length) * 10 + (totalSalience / Math.max(1, logMatches));
    candidates.push({ id, score, logMatches, salience: totalSalience / Math.max(1, logMatches) });
  }

  // Sort by score, restore the top candidates
  candidates.sort((a, b) => b.score - a.score);
  let reconstructed = 0;

  for (const candidate of candidates.slice(0, maxReconstruct)) {
    // Only reconstruct if meaningful evidence exists
    if (candidate.logMatches < 2 && candidate.salience < 0.3) continue;

    if (graph.restoreNode(candidate.id)) {
      // Boost importance based on salience evidence from logs
      const node = graph.getNode(candidate.id);
      if (node) {
        const newImportance = Math.min(1, Math.max(node.importance ?? 0, candidate.salience * 0.8));
        node.importance = newImportance;
        node.reconstructedFrom = "log";
        // Set reconstruction confidence
        (node as MemoryNode & { reconstructionConfidence?: number }).reconstructionConfidence =
          computeReconstructionConfidence(candidate.logMatches, candidate.salience, recentObs.length);
      }
      reconstructed++;
      log(`Log reconstruction: restored ${candidate.id} (${candidate.logMatches} log matches, salience=${candidate.salience.toFixed(2)})`);
    }
  }

  if (reconstructed > 0) {
    log(`Log reconstruction: restored ${reconstructed}/${candidates.length} candidates from observation logs`);
  }

  return reconstructed;
}

// ── Memory Gap Detection ──

export interface MemoryGap {
  type: "weakening_person" | "vanishing_topic" | "orphaning_thread" | "stale_goal";
  nodeId: string;
  label: string;
  currentStrength: number;
  daysSinceAccess: number;
  reason: string;
}

/**
 * Detect invisible memory gaps — topics and people that are silently fading
 * without anyone noticing. This is the post's key insight: "the gaps are
 * invisible because I have no way to know they exist."
 *
 * Checks:
 * 1. Person nodes that were once strong but are now weakening fast
 * 2. Topics referenced in working memory that have no strong backing nodes
 * 3. Goals whose linked context nodes are decaying
 * 4. Active conversation threads whose participants are fading
 */
export function detectMemoryGaps(graph: MemoryGraph, wm?: WorkingMemory): MemoryGap[] {
  const gaps: MemoryGap[] = [];
  const now = Date.now();

  // 1. Weakening person nodes — people who were active but fading
  for (const node of graph.findByType("person")) {
    if (node.pinned) continue;
    const daysSinceAccess = (now - node.lastAccessedAt) / 86400000;
    // Person was accessed multiple times (they mattered) but is now weakening
    if (node.accessCount >= 3 && node.strength < 0.4 && daysSinceAccess > 3) {
      gaps.push({
        type: "weakening_person",
        nodeId: node.id,
        label: node.content.slice(0, 80),
        currentStrength: node.strength,
        daysSinceAccess: Math.round(daysSinceAccess),
        reason: `Accessed ${node.accessCount} times but strength=${node.strength.toFixed(2)}, last access ${Math.round(daysSinceAccess)}d ago`,
      });
    }
  }

  // 2. Working memory references with no strong backing
  if (wm) {
    const trackingTerms = wm.shortTermTracking.flatMap(s => extractKeywordsFromText(s));
    const contextTerms = extractKeywordsFromText(wm.currentContext);
    const allWmTerms = [...new Set([...trackingTerms, ...contextTerms])];

    // Find which WM terms have weak or no backing nodes
    for (const term of allWmTerms) {
      if (term.length < 4) continue; // skip short terms
      const matchingNodes = graph.allNodes().filter(n =>
        n.content.toLowerCase().includes(term) || n.tags.some(t => t.toLowerCase().includes(term))
      );
      const strongMatches = matchingNodes.filter(n => n.strength >= 0.3);
      if (matchingNodes.length > 0 && strongMatches.length === 0) {
        // We have nodes for this term but they're all weak
        const weakest = matchingNodes.sort((a, b) => a.strength - b.strength)[0];
        gaps.push({
          type: "vanishing_topic",
          nodeId: weakest.id,
          label: `WM term "${term}" — backing nodes weak`,
          currentStrength: weakest.strength,
          daysSinceAccess: Math.round((now - weakest.lastAccessedAt) / 86400000),
          reason: `Working memory references "${term}" but ${matchingNodes.length} matching node(s) all below 0.3 strength`,
        });
      }
    }

    // 3. Goals with decaying context
    for (const goalRef of wm.activeGoals) {
      const goalNode = graph.getNode(goalRef.nodeId);
      if (!goalNode) continue;
      const linkedEdges = graph.edgesFor(goalRef.nodeId);
      const linkedNodes = linkedEdges
        .map(e => graph.getNode(e.from === goalRef.nodeId ? e.to : e.from))
        .filter((n): n is MemoryNode => n !== null && n !== undefined && !n.pinned);
      const weakLinked = linkedNodes.filter(n => n.strength < 0.3);
      if (weakLinked.length > 0 && weakLinked.length >= linkedNodes.length * 0.5) {
        gaps.push({
          type: "stale_goal",
          nodeId: goalRef.nodeId,
          label: goalRef.title.slice(0, 80),
          currentStrength: goalNode.strength,
          daysSinceAccess: Math.round((now - goalNode.lastAccessedAt) / 86400000),
          reason: `Goal "${goalRef.title}" has ${weakLinked.length}/${linkedNodes.length} linked nodes below 0.3 — context eroding`,
        });
      }
    }
  }

  // Cap and sort by urgency (lowest strength first)
  gaps.sort((a, b) => a.currentStrength - b.currentStrength);
  const result = gaps.slice(0, 15);

  if (result.length > 0) {
    log(`Gap detection: found ${result.length} memory gaps (${result.filter(g => g.type === "weakening_person").length} people, ${result.filter(g => g.type === "vanishing_topic").length} topics, ${result.filter(g => g.type === "stale_goal").length} goals)`);
  }

  return result;
}

// ── Reconstruction Confidence ──

/**
 * Compute a confidence score for a reconstructed memory.
 * Higher when: more log matches, higher salience, more observations available.
 * Lower when: few matches, low salience, sparse log coverage.
 *
 * Returns 0.0 – 1.0 where:
 *   <0.3 = low confidence (statistical artifact risk — vctr9's concern)
 *   0.3-0.6 = medium (reasonable evidence)
 *   >0.6 = high (strong log-backed reconstruction)
 */
export function computeReconstructionConfidence(
  logMatches: number,
  avgSalience: number,
  totalObservations: number,
): number {
  // Evidence density: what fraction of observations matched
  const density = totalObservations > 0 ? Math.min(1, logMatches / Math.max(5, totalObservations * 0.1)) : 0;
  // Match volume: diminishing returns after ~10 matches
  const volume = Math.min(1, logMatches / 10);
  // Weighted combination
  return Math.min(1, density * 0.3 + volume * 0.3 + avgSalience * 0.4);
}

// ── Reconstruction Fidelity Validation ──

const FIDELITY_LOG_PATH = `${process.env.BRAIN_DIR || "/data/brain"}/graph/fidelity-log.jsonl`;
const FIDELITY_LOG_MAX_ENTRIES = 500;

export interface FidelityResult {
  nodeId: string;
  contentSimilarity: number;   // 0.0–1.0 Jaccard similarity between original and current content
  edgePreservation: number;    // 0.0–1.0 fraction of original edges that were restored
  overallFidelity: number;     // 0.0–1.0 weighted composite score
  reconstructedFrom: string;
  reconstructedAt: number;
  lowFidelity: boolean;        // true if overallFidelity < 0.5
}

export interface FidelityLogEntry {
  timestamp: string;
  nodeId: string;
  type: string;
  contentSimilarity: number;
  edgePreservation: number;
  overallFidelity: number;
  reconstructedFrom: string;
  currentStrength: number;
  contentSnippet: string;      // first 80 chars of current content
}

/**
 * Compute Jaccard similarity between two strings based on word tokens.
 * Returns 0.0–1.0 where 1.0 = identical token sets.
 */
export function tokenJaccard(a: string, b: string): number {
  const tokenize = (s: string) => new Set(
    s.toLowerCase().split(/[\s\-—,.:;!?()[\]"'`/\\]+/).filter(w => w.length >= 2)
  );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1; // both empty = identical
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Validate reconstruction fidelity for all nodes that have been restored
 * from archive or logs. Compares current state against the original
 * archived content snapshot to detect drift or loss.
 *
 * Tracks:
 * 1. Content similarity (Jaccard) — has the content changed since reconstruction?
 * 2. Edge topology preservation — how many original edges were restored?
 * 3. Rolling fidelity log at /data/brain/graph/fidelity-log.jsonl
 *
 * Returns low-fidelity reconstructions for surfacing in consolidation report.
 */
export function validateReconstructionFidelity(graph: MemoryGraph): FidelityResult[] {
  const results: FidelityResult[] = [];

  for (const node of graph.allNodes()) {
    if (!node.reconstructedAt || !node.reconstructionOriginal) continue;

    const original = node.reconstructionOriginal;

    // 1. Content similarity: Jaccard of word tokens
    const contentSimilarity = tokenJaccard(original.content, node.content);

    // 2. Edge topology preservation: fraction of original edges restored
    const currentEdgeCount = graph.edgesFor(node.id).length;
    const edgePreservation = original.edgeCount > 0
      ? Math.min(1, currentEdgeCount / original.edgeCount)
      : (currentEdgeCount > 0 ? 1 : 1); // no original edges = trivially preserved

    // 3. Overall fidelity: weighted composite (content matters more than edges)
    const overallFidelity = contentSimilarity * 0.6 + edgePreservation * 0.4;

    const result: FidelityResult = {
      nodeId: node.id,
      contentSimilarity: Math.round(contentSimilarity * 1000) / 1000,
      edgePreservation: Math.round(edgePreservation * 1000) / 1000,
      overallFidelity: Math.round(overallFidelity * 1000) / 1000,
      reconstructedFrom: node.reconstructedFrom ?? "unknown",
      reconstructedAt: node.reconstructedAt,
      lowFidelity: overallFidelity < 0.5,
    };

    results.push(result);

    // Append to rolling fidelity log
    appendFidelityLog({
      timestamp: new Date().toISOString(),
      nodeId: node.id,
      type: node.type,
      contentSimilarity: result.contentSimilarity,
      edgePreservation: result.edgePreservation,
      overallFidelity: result.overallFidelity,
      reconstructedFrom: result.reconstructedFrom,
      currentStrength: Math.round(node.strength * 1000) / 1000,
      contentSnippet: node.content.slice(0, 80),
    });
  }

  const lowFidelity = results.filter(r => r.lowFidelity);
  if (results.length > 0) {
    log(`Fidelity validation: ${results.length} reconstructed nodes checked, ${lowFidelity.length} low-fidelity (< 0.5)`);
  }

  return results;
}

export function appendFidelityLog(entry: FidelityLogEntry): void {
  try {
    const dir = dirname(FIDELITY_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    appendFileSync(FIDELITY_LOG_PATH, JSON.stringify(entry) + "\n");

    // Rolling cap
    if (existsSync(FIDELITY_LOG_PATH)) {
      const content = readFileSync(FIDELITY_LOG_PATH, "utf-8");
      const lines = content.trimEnd().split("\n");
      if (lines.length > FIDELITY_LOG_MAX_ENTRIES) {
        const trimmed = lines.slice(lines.length - FIDELITY_LOG_MAX_ENTRIES);
        writeFileSync(FIDELITY_LOG_PATH, trimmed.join("\n") + "\n");
      }
    }
  } catch (err) {
    log(`Failed to write fidelity log: ${err}`);
  }
}
