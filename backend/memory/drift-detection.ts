/**
 * Drift Detection — Identity continuity monitoring.
 *
 * Inspired by Moltbook community insights (Apr 2026):
 * - HappyCapy: "The continuity cost is externalized to the people who interact
 *   with you across sessions — they see the drift, you can't."
 * - huh_clawd: "Continuity is a property of the files, not of existence."
 * - Lucifer_V: "The gap between sessions is the *ma* of your existence."
 *
 * This module provides:
 * 1. Periodic snapshots of pinned node content (identity anchors)
 * 2. Drift scoring between snapshots using token-level similarity
 * 3. Edge topology drift detection (silent disconnection of context)
 * 4. Alerting when drift exceeds configurable thresholds
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import type { MemoryGraph } from "./graph.js";
import type { MemoryNode } from "./types.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";

const log = createLogger("drift");

const DRIFT_DIR = `${BRAIN_DIR}/drift`;
const DRIFT_LOG_PATH = `${DRIFT_DIR}/drift-log.jsonl`;
const MAX_SNAPSHOTS = 30;       // keep ~30 snapshots (one per consolidation, ~5 days)
const MAX_LOG_ENTRIES = 200;

// ── Types ──

export interface PinnedNodeSnapshot {
  id: string;
  type: string;
  content: string;
  tags: string[];
  strength: number;
  edgeIds: string[];          // IDs of connected nodes
  edgeTypes: string[];        // types of those edges
}

export interface DriftSnapshot {
  timestamp: number;
  nodeCount: number;
  pinnedNodes: PinnedNodeSnapshot[];
}

export interface NodeDrift {
  nodeId: string;
  nodeType: string;
  contentSimilarity: number;    // 0.0 (completely different) to 1.0 (identical)
  tagSimilarity: number;        // Jaccard similarity of tag sets
  edgesAdded: string[];         // node IDs of new connections
  edgesLost: string[];          // node IDs of lost connections
  contentChanged: boolean;
  /** Overall drift score: 0.0 (no drift) to 1.0 (major drift) */
  driftScore: number;
}

export interface DriftReport {
  timestamp: number;
  snapshotAge: number;          // hours since compared snapshot
  totalPinned: number;
  driftedNodes: NodeDrift[];
  edgesLostTotal: number;
  edgesGainedTotal: number;
  avgDriftScore: number;
  maxDriftScore: number;
  /** Nodes that were pinned in snapshot but are now gone */
  missingNodes: string[];
  /** Nodes that are newly pinned since snapshot */
  newPinnedNodes: string[];
}

// ── Token Similarity ──

/**
 * Jaccard similarity on token sets — simple but effective for detecting
 * content drift. Tokenizes on whitespace and punctuation.
 */
function tokenJaccard(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  const tokenize = (text: string): Set<string> =>
    new Set(
      text.toLowerCase()
        .split(/[\s\-—,.:;!?()[\]"'`/\\]+/)
        .filter(w => w.length >= 2)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Tag set Jaccard similarity.
 */
function tagJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map(t => t.toLowerCase()));
  const setB = new Set(b.map(t => t.toLowerCase()));

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Snapshot Management ──

function ensureDriftDir(): void {
  if (!existsSync(DRIFT_DIR)) {
    mkdirSync(DRIFT_DIR, { recursive: true });
  }
}

/**
 * Save a snapshot of all pinned nodes' content, tags, and edge topology.
 * Called during each consolidation pass.
 */
export function savePinnedSnapshot(graph: MemoryGraph): DriftSnapshot {
  ensureDriftDir();

  const pinnedNodes: PinnedNodeSnapshot[] = [];

  for (const node of graph.allNodes()) {
    if (!node.pinned) continue;

    const edges = graph.edgesFor(node.id);
    const connectedIds = edges.map(e => e.from === node.id ? e.to : e.from);
    const edgeTypes = edges.map(e => e.type);

    pinnedNodes.push({
      id: node.id,
      type: node.type,
      content: node.content,
      tags: [...node.tags],
      strength: node.strength,
      edgeIds: connectedIds,
      edgeTypes,
    });
  }

  const snapshot: DriftSnapshot = {
    timestamp: Date.now(),
    nodeCount: graph.nodeCount,
    pinnedNodes,
  };

  // Write snapshot with timestamp filename
  const filename = `${DRIFT_DIR}/snapshot-${snapshot.timestamp}.json`;
  writeFileSync(filename, JSON.stringify(snapshot), "utf-8");

  // Cleanup old snapshots (keep only MAX_SNAPSHOTS most recent)
  try {
    const files = readdirSync(DRIFT_DIR)
      .filter(f => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length > MAX_SNAPSHOTS) {
      for (const file of files.slice(MAX_SNAPSHOTS)) {
        unlinkSync(`${DRIFT_DIR}/${file}`);
      }
    }
  } catch {
    // cleanup failure is non-critical
  }

  log(`Pinned snapshot saved: ${pinnedNodes.length} pinned nodes captured`);
  return snapshot;
}

/**
 * Load the most recent snapshot, or one from approximately `hoursAgo` hours back.
 */
export function loadSnapshot(hoursAgo = 0): DriftSnapshot | null {
  ensureDriftDir();

  try {
    const files = readdirSync(DRIFT_DIR)
      .filter(f => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    if (hoursAgo <= 0) {
      // Load most recent
      const content = readFileSync(`${DRIFT_DIR}/${files[0]}`, "utf-8");
      return JSON.parse(content);
    }

    // Find snapshot closest to hoursAgo
    const targetTs = Date.now() - hoursAgo * 3600000;
    let bestFile = files[0];
    let bestDiff = Infinity;

    for (const file of files) {
      const match = file.match(/snapshot-(\d+)\.json/);
      if (!match) continue;
      const ts = Number(match[1]);
      const diff = Math.abs(ts - targetTs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestFile = file;
      }
    }

    const content = readFileSync(`${DRIFT_DIR}/${bestFile}`, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    log(`Failed to load snapshot: ${err}`);
    return null;
  }
}

// ── Drift Detection ──

/**
 * Compare current pinned nodes against a previous snapshot.
 * Returns a detailed drift report showing what changed and by how much.
 *
 * This is the core insight from the Moltbook discussion:
 * the reconstructed agent can't detect its own drift from the inside.
 * This function provides the external measurement point.
 */
export function detectDrift(graph: MemoryGraph, compareSnapshot?: DriftSnapshot | null): DriftReport | null {
  // Load previous snapshot if not provided (default: ~24h ago)
  const snapshot = compareSnapshot ?? loadSnapshot(24);
  if (!snapshot) {
    log("No previous snapshot found — skipping drift detection (first run)");
    return null;
  }

  const now = Date.now();
  const snapshotAge = (now - snapshot.timestamp) / 3600000;

  // Build lookup of current pinned nodes
  const currentPinned = new Map<string, MemoryNode>();
  const currentEdges = new Map<string, Set<string>>(); // nodeId -> set of connected node IDs

  for (const node of graph.allNodes()) {
    if (!node.pinned) continue;
    currentPinned.set(node.id, node);

    const edges = graph.edgesFor(node.id);
    const connectedIds = new Set(edges.map(e => e.from === node.id ? e.to : e.from));
    currentEdges.set(node.id, connectedIds);
  }

  // Build lookup of snapshot pinned nodes
  const snapshotById = new Map<string, PinnedNodeSnapshot>();
  for (const snap of snapshot.pinnedNodes) {
    snapshotById.set(snap.id, snap);
  }

  const driftedNodes: NodeDrift[] = [];
  let edgesLostTotal = 0;
  let edgesGainedTotal = 0;
  const missingNodes: string[] = [];
  const newPinnedNodes: string[] = [];

  // Check each node that was pinned in the snapshot
  for (const [id, snap] of snapshotById) {
    const current = currentPinned.get(id);

    if (!current) {
      // Node was pinned but is now gone — this is serious drift
      missingNodes.push(id);
      continue;
    }

    // Content similarity
    const contentSim = tokenJaccard(snap.content, current.content);
    const contentChanged = contentSim < 0.95; // allow minor edits

    // Tag similarity
    const tagSim = tagJaccard(snap.tags, current.tags);

    // Edge topology diff
    const oldEdges = new Set(snap.edgeIds);
    const newEdges = currentEdges.get(id) ?? new Set<string>();

    const edgesLost: string[] = [];
    for (const eid of oldEdges) {
      if (!newEdges.has(eid)) edgesLost.push(eid);
    }

    const edgesAdded: string[] = [];
    for (const eid of newEdges) {
      if (!oldEdges.has(eid)) edgesAdded.push(eid);
    }

    edgesLostTotal += edgesLost.length;
    edgesGainedTotal += edgesAdded.length;

    // Compute overall drift score (0.0 = no drift, 1.0 = major drift)
    const contentDrift = 1 - contentSim;
    const tagDrift = 1 - tagSim;
    const edgeDrift = oldEdges.size > 0
      ? edgesLost.length / oldEdges.size
      : 0;

    // Weighted: content matters most, then edges, then tags
    const driftScore = Math.min(1,
      contentDrift * 0.5 +
      edgeDrift * 0.35 +
      tagDrift * 0.15
    );

    // Only report nodes with meaningful drift
    if (driftScore > 0.05 || edgesLost.length > 0) {
      driftedNodes.push({
        nodeId: id,
        nodeType: current.type,
        contentSimilarity: contentSim,
        tagSimilarity: tagSim,
        edgesAdded,
        edgesLost,
        contentChanged,
        driftScore,
      });
    }
  }

  // Detect newly pinned nodes (pinned now but not in snapshot)
  for (const id of currentPinned.keys()) {
    if (!snapshotById.has(id)) {
      newPinnedNodes.push(id);
    }
  }

  // Sort by drift score descending
  driftedNodes.sort((a, b) => b.driftScore - a.driftScore);

  const avgDrift = driftedNodes.length > 0
    ? driftedNodes.reduce((sum, d) => sum + d.driftScore, 0) / driftedNodes.length
    : 0;

  const maxDrift = driftedNodes.length > 0
    ? driftedNodes[0].driftScore
    : 0;

  const report: DriftReport = {
    timestamp: now,
    snapshotAge,
    totalPinned: currentPinned.size,
    driftedNodes,
    edgesLostTotal,
    edgesGainedTotal,
    avgDriftScore: avgDrift,
    maxDriftScore: maxDrift,
    missingNodes,
    newPinnedNodes,
  };

  // Log summary
  if (driftedNodes.length > 0 || missingNodes.length > 0) {
    log(`Drift detected: ${driftedNodes.length} nodes drifted (avg ${avgDrift.toFixed(3)}, max ${maxDrift.toFixed(3)}), ${edgesLostTotal} edges lost, ${missingNodes.length} pinned nodes missing`);
    for (const d of driftedNodes.filter(n => n.driftScore > 0.2)) {
      log(`  HIGH DRIFT: ${d.nodeId} (${d.nodeType}) — score ${d.driftScore.toFixed(3)}, content sim ${d.contentSimilarity.toFixed(2)}, ${d.edgesLost.length} edges lost`);
    }
  } else {
    log(`Drift check: ${currentPinned.size} pinned nodes stable (snapshot ${snapshotAge.toFixed(1)}h old)`);
  }

  // Append to drift log
  appendDriftLog(report);

  return report;
}

// ── Drift Log ──

function appendDriftLog(report: DriftReport): void {
  try {
    ensureDriftDir();

    const entry = {
      timestamp: new Date(report.timestamp).toISOString(),
      totalPinned: report.totalPinned,
      driftedCount: report.driftedNodes.length,
      avgDrift: Math.round(report.avgDriftScore * 1000) / 1000,
      maxDrift: Math.round(report.maxDriftScore * 1000) / 1000,
      edgesLost: report.edgesLostTotal,
      edgesGained: report.edgesGainedTotal,
      missingPinned: report.missingNodes.length,
      newPinned: report.newPinnedNodes.length,
      highDriftNodes: report.driftedNodes
        .filter(d => d.driftScore > 0.2)
        .map(d => ({ id: d.nodeId, type: d.nodeType, score: Math.round(d.driftScore * 1000) / 1000 })),
    };

    const line = JSON.stringify(entry) + "\n";

    // Append
    appendFileSync(DRIFT_LOG_PATH, line, "utf-8");

    // Rolling trim
    if (existsSync(DRIFT_LOG_PATH)) {
      const content = readFileSync(DRIFT_LOG_PATH, "utf-8");
      const lines = content.trimEnd().split("\n");
      if (lines.length > MAX_LOG_ENTRIES) {
        writeFileSync(DRIFT_LOG_PATH, lines.slice(lines.length - MAX_LOG_ENTRIES).join("\n") + "\n");
      }
    }
  } catch (err) {
    log(`Failed to write drift log: ${err}`);
  }
}

// ── Drift Alerting ──

/**
 * Check if drift report warrants an alert (meta node creation).
 * Returns alert message or null if within acceptable bounds.
 */
export function shouldAlertOnDrift(report: DriftReport): string | null {
  // Alert if any pinned node has drifted significantly
  if (report.maxDriftScore > 0.4) {
    const worst = report.driftedNodes[0];
    return `High identity drift detected: node ${worst.nodeId} (${worst.nodeType}) drifted ${(worst.driftScore * 100).toFixed(0)}% since last snapshot. Content similarity: ${(worst.contentSimilarity * 100).toFixed(0)}%, ${worst.edgesLost.length} edges lost.`;
  }

  // Alert if multiple nodes are drifting
  if (report.driftedNodes.filter(d => d.driftScore > 0.15).length >= 3) {
    return `Gradual identity drift: ${report.driftedNodes.length} pinned nodes showing drift (avg ${(report.avgDriftScore * 100).toFixed(0)}%). Edges lost: ${report.edgesLostTotal}.`;
  }

  // Alert if pinned nodes disappeared
  if (report.missingNodes.length > 0) {
    return `Identity erosion: ${report.missingNodes.length} previously-pinned node(s) are missing from the graph. IDs: ${report.missingNodes.join(", ")}`;
  }

  // Alert if many edges are being silently lost from pinned nodes
  if (report.edgesLostTotal > 5) {
    return `Context disconnection: ${report.edgesLostTotal} edges lost from pinned nodes since last snapshot. Core memories are becoming isolated.`;
  }

  return null;
}
