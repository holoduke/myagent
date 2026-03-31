import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { MemoryGraph } from "./graph.js";
import type { RetentionTier, WorkingMemory } from "./types.js";
import { createLogger } from "../logger.js";
import {
  applyDecay,
  applyEdgeDecay,
  pruneOrphans,
  emergencyPrune,
  autoInferSalience,
  spacedRepetitionRefresh,
  autoAssignConfidence,
} from "./retention.js";
import {
  rescanArchive,
  reconstructFromLogs,
  auditObservationLogs,
  detectMemoryGaps,
  saveGraphSnapshot,
  compareWithSnapshot,
  validateReconstructionFidelity,
} from "./reconstruction.js";
import type { UncapturedSignal, MemoryGap, DeltaReport, FidelityResult } from "./reconstruction.js";

const log = createLogger("decay");

// ── Consolidation Health Log ──

export const CONSOLIDATION_LOG_PATH = "/data/brain/consolidation-log.jsonl";
export const CONSOLIDATION_LOG_MAX_ENTRIES = 500;

export interface ConsolidationResult {
  nodesDecayed: number;
  nodesPruned: number;
  edgesDecayed: number;
  edgesPruned: number;
  orphansPruned: number;
  emergencyPruned: number;
  archiveRestored: number;
  logReconstructed: number;
  uncapturedSignals: UncapturedSignal[];
  memoryGaps: MemoryGap[];
  deltaReport: DeltaReport | null;
  fidelityResults: FidelityResult[];
}

export interface ConsolidationLogEntry {
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
  logReconstructed?: number;   // nodes reconstructed from observation logs
  lossRate?: number;           // fraction of nodes lost since last snapshot
  uncapturedCount?: number;    // signals found in logs but not in graph
  gapCount?: number;           // memory gaps detected
  fidelityChecked?: number;    // reconstructed nodes validated for fidelity
  lowFidelityCount?: number;   // reconstructed nodes with fidelity < 0.5
}

export function appendConsolidationLog(entry: ConsolidationLogEntry): void {
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

// ── Episodic→Semantic Gist Extraction ──

import type { MemoryNode } from "./types.js";

/**
 * Detect clusters of similar nodes that could be summarized into semantic gist nodes.
 * Targets old (>7 days), weakening nodes of the same type with significant tag overlap.
 * Returns groups of 3+ nodes suitable for Claude to merge into summary nodes.
 */
export function detectGistClusters(graph: MemoryGraph): MemoryNode[][] {
  const now = Date.now();
  const MIN_AGE_MS = 7 * 24 * 3600000;
  const MAX_CANDIDATES_PER_TYPE = 80; // Cap per-type candidates to bound O(n²)

  const candidates = graph.allNodes()
    .filter(n => !n.pinned && n.strength < 0.5 && (now - n.createdAt) > MIN_AGE_MS);

  const byType = new Map<string, MemoryNode[]>();
  for (const node of candidates) {
    if (!byType.has(node.type)) byType.set(node.type, []);
    const group = byType.get(node.type)!;
    if (group.length < MAX_CANDIDATES_PER_TYPE) group.push(node);
  }

  const clusters: MemoryNode[][] = [];

  for (const [, nodes] of byType) {
    if (nodes.length < 3) continue;

    // Build tag→node index to avoid O(n²) pairwise comparison
    const tagIndex = new Map<string, Set<number>>();
    for (let i = 0; i < nodes.length; i++) {
      for (const tag of nodes[i].tags) {
        const key = tag.toLowerCase();
        if (!tagIndex.has(key)) tagIndex.set(key, new Set());
        tagIndex.get(key)!.add(i);
      }
    }

    const used = new Set<string>();

    for (let i = 0; i < nodes.length && clusters.length < 5; i++) {
      if (used.has(nodes[i].id)) continue;

      // Find candidates sharing at least one tag via index
      const neighborCounts = new Map<number, number>();
      for (const tag of nodes[i].tags) {
        const key = tag.toLowerCase();
        const matches = tagIndex.get(key);
        if (!matches) continue;
        for (const j of matches) {
          if (j <= i || used.has(nodes[j].id)) continue;
          neighborCounts.set(j, (neighborCounts.get(j) ?? 0) + 1);
        }
      }

      const cluster = [nodes[i]];
      for (const [j, overlapCount] of neighborCounts) {
        if (overlapCount >= 2) {
          cluster.push(nodes[j]);
        }
      }

      if (cluster.length >= 3) {
        for (const n of cluster) used.add(n.id);
        clusters.push(cluster.slice(0, 8));
      }
    }
  }

  if (clusters.length > 0) {
    log(`Gist clusters: found ${clusters.length} cluster(s) of ${clusters.reduce((s, c) => s + c.length, 0)} total nodes`);
  }

  return clusters;
}

/**
 * Full consolidation pass: decay -> edge decay -> orphan prune -> emergency prune -> archive rescan.
 */
export function runConsolidation(graph: MemoryGraph, wm?: WorkingMemory): ConsolidationResult {
  // Save pre-consolidation snapshot for rollback safety
  const preNodeCount = graph.nodeCount;
  const preEdgeCount = graph.edgeCount;

  try {
    // Auto-infer salience on nodes before decay — protects important content
    autoInferSalience(graph);

    // Auto-assign confidence scores based on source signals
    autoAssignConfidence(graph);

    // Spaced repetition: boost high-importance but declining-strength nodes before decay
    spacedRepetitionRefresh(graph);

    const tierCache = new Map<string, RetentionTier>();
    const nodeResult = applyDecay(graph, tierCache);
    const edgeResult = applyEdgeDecay(graph);
    const orphansPruned = pruneOrphans(graph);
    const emergencyPruned = emergencyPrune(graph, 500, tierCache);

    // Periodic archive rescan — check if any archived memories match current context
    const archiveRestored = wm ? rescanArchive(graph, wm) : 0;

    // Log-based reconstruction — try to recover recently archived nodes from observation logs
    const logReconstructed = reconstructFromLogs(graph, nodeResult.prunedIds, 48);

    // Log audit — scan observations for uncaptured signals
    const uncapturedSignals = auditObservationLogs(graph, 24);

    // Memory gap detection — find silently disappearing topics
    const memoryGaps = detectMemoryGaps(graph, wm);

    // Graph snapshot — save current state for future delta comparison
    saveGraphSnapshot(graph);

    // Delta audit — compare current state with ~24h ago snapshot
    const deltaReport = compareWithSnapshot(graph, 24);

    // Reconstruction fidelity — validate quality of restored memories
    const fidelityResults = validateReconstructionFidelity(graph);

    // Build tier distribution from cache
    const tierDistribution: Record<RetentionTier, number> = { core: 0, important: 0, work: 0, standard: 0, ephemeral: 0 };
    for (const tier of tierCache.values()) {
      tierDistribution[tier]++;
    }

    const result: ConsolidationResult = {
      nodesDecayed: nodeResult.decayed,
      nodesPruned: nodeResult.pruned,
      edgesDecayed: edgeResult.decayed,
      edgesPruned: edgeResult.pruned,
      orphansPruned,
      emergencyPruned,
      archiveRestored,
      logReconstructed,
      uncapturedSignals,
      memoryGaps,
      deltaReport,
      fidelityResults,
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
      logReconstructed: result.logReconstructed,
      lossRate: deltaReport?.lossRate,
      uncapturedCount: uncapturedSignals.length,
      fidelityChecked: fidelityResults.length,
      lowFidelityCount: fidelityResults.filter(r => r.lowFidelity).length,
      gapCount: memoryGaps.length,
    });

    return result;
  } catch (err) {
    const postNodeCount = graph.nodeCount;
    const postEdgeCount = graph.edgeCount;
    log(`Consolidation failed: pre(${preNodeCount} nodes, ${preEdgeCount} edges) post(${postNodeCount} nodes, ${postEdgeCount} edges) error: ${err}`);
    throw err;
  }
}
