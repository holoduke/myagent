import { appendRollingJsonl } from "../utils/file-store.js";
import { clusterByTagOverlap } from "./text-utils.js";
import type { MemoryGraph } from "./graph.js";
import type { MemoryNode, RetentionTier, WorkingMemory } from "./types.js";
import { createLogger } from "../logger.js";
import {
  applyDecay,
  applyEdgeDecay,
  pruneOrphans,
  emergencyPrune,
  autoInferSalience,
  spacedRepetitionRefresh,
  autoAssignConfidence,
  pruneRejectedEdges,
} from "./retention.js";
import { flushEmbeddings } from "./embeddings.js";
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
import { savePinnedSnapshot, detectDrift, shouldAlertOnDrift } from "./drift-detection.js";
import type { DriftReport } from "./drift-detection.js";

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
  driftReport: DriftReport | null;
  driftAlert: string | null;
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
  ghostCount?: number;           // topology-only remnants in ghost graph
  logReconstructed?: number;   // nodes reconstructed from observation logs
  lossRate?: number;           // fraction of nodes lost since last snapshot
  uncapturedCount?: number;    // signals found in logs but not in graph
  gapCount?: number;           // memory gaps detected
  fidelityChecked?: number;    // reconstructed nodes validated for fidelity
  lowFidelityCount?: number;   // reconstructed nodes with fidelity < 0.5
  driftScore?: number;         // max drift score across pinned nodes
  driftedCount?: number;       // number of pinned nodes showing drift
  pinnedEdgesLost?: number;    // edges lost from pinned nodes since last snapshot
}

export function appendConsolidationLog(entry: ConsolidationLogEntry): void {
  try {
    appendRollingJsonl(CONSOLIDATION_LOG_PATH, entry, CONSOLIDATION_LOG_MAX_ENTRIES);
  } catch (err) {
    log(`Failed to write consolidation log: ${err}`);
  }
}

// ── Episodic→Semantic Gist Extraction ──

const GIST_MIN_AGE_MS = 7 * 24 * 3600000;
const GIST_MAX_CANDIDATES_PER_TYPE = 80; // bounds the per-type clustering work
const GIST_MAX_CLUSTERS = 5;

/**
 * Detect clusters of similar nodes that could be summarized into semantic gist nodes.
 * Targets old (>7 days), weakening nodes of the same type with significant tag overlap.
 * Returns groups of 3+ nodes suitable for Claude to merge into summary nodes.
 */
export function detectGistClusters(graph: MemoryGraph): MemoryNode[][] {
  const now = Date.now();
  const candidates = graph.allNodes()
    .filter(n => !n.pinned && n.strength < 0.5 && (now - n.createdAt) > GIST_MIN_AGE_MS);

  const byType = new Map<string, MemoryNode[]>();
  for (const node of candidates) {
    const group = byType.get(node.type) ?? [];
    if (group.length < GIST_MAX_CANDIDATES_PER_TYPE) byType.set(node.type, [...group, node]);
  }

  const clusters: MemoryNode[][] = [];
  for (const nodes of byType.values()) {
    if (clusters.length >= GIST_MAX_CLUSTERS) break;
    const found = clusterByTagOverlap(nodes, {
      minSharedTags: 2,
      minClusterSize: 3,
      maxClusterSize: 8,
      maxClusters: GIST_MAX_CLUSTERS - clusters.length,
    });
    clusters.push(...found.map(c => c.nodes));
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
    // Memory flush before compaction (OpenClaw pattern):
    // Persist any in-memory buffers to disk before decay/prune operations.
    // Prevents losing recent data if compaction triggers a crash or heavy GC.
    try {
      graph.save();           // Flush graph state (nodes, edges, archive, ghosts)
      flushEmbeddings();      // Flush embedding cache to disk
      log("Pre-consolidation flush complete");
    } catch (flushErr) {
      log(`Pre-consolidation flush warning (non-fatal): ${flushErr}`);
      // Continue — flush failure shouldn't block consolidation
    }

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
    const emergencyPruned = emergencyPrune(graph, tierCache);
    pruneRejectedEdges(graph);

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

    // Drift detection — compare pinned nodes against previous snapshot
    // Run BEFORE saving new snapshot so we compare against the old one
    const driftReport = detectDrift(graph);
    const driftAlert = driftReport ? shouldAlertOnDrift(driftReport) : null;
    if (driftAlert) {
      log(`⚠ DRIFT ALERT: ${driftAlert}`);
    }

    // Save new pinned snapshot for next comparison
    savePinnedSnapshot(graph);

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
      driftReport,
      driftAlert,
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
      ghostCount: graph.ghostCount,
      logReconstructed: result.logReconstructed,
      lossRate: deltaReport?.lossRate,
      uncapturedCount: uncapturedSignals.length,
      fidelityChecked: fidelityResults.length,
      lowFidelityCount: fidelityResults.filter(r => r.lowFidelity).length,
      gapCount: memoryGaps.length,
      driftScore: driftReport?.maxDriftScore,
      driftedCount: driftReport?.driftedNodes.length,
      pinnedEdgesLost: driftReport?.edgesLostTotal,
    });

    return result;
  } catch (err) {
    const postNodeCount = graph.nodeCount;
    const postEdgeCount = graph.edgeCount;
    log(`Consolidation failed: pre(${preNodeCount} nodes, ${preEdgeCount} edges) post(${postNodeCount} nodes, ${postEdgeCount} edges) error: ${err}`);
    throw err;
  }
}
