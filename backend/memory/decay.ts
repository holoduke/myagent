// Re-export everything for backward compatibility.
// The actual implementations have been split into focused modules:
//   - retention.ts   — tier classification, decay, pruning, salience
//   - consolidation.ts — consolidation orchestrator and health logging
//   - reconstruction.ts — archive rescan, log reconstruction, gap detection, fidelity

// ── retention.ts ──
export {
  TIER_PRIORITY,
  TIER_SORT_PRIORITY,
  classifyRetentionTier,
  applyDecay,
  applyEdgeDecay,
  pruneOrphans,
  emergencyPrune,
  autoInferSalience,
  inferContentSalience,
  inferEmotionalValence,
  spacedRepetitionRefresh,
  autoAssignConfidence,
  pruneRejectedEdges,
  SALIENCE_SIGNALS,
} from "./retention.js";

// ── consolidation.ts ──
export {
  runConsolidation,
  detectGistClusters,
  appendConsolidationLog,
  CONSOLIDATION_LOG_PATH,
  CONSOLIDATION_LOG_MAX_ENTRIES,
} from "./consolidation.js";
export type { ConsolidationResult, ConsolidationLogEntry } from "./consolidation.js";

// ── reconstruction.ts ──
export {
  rescanArchive,
  RESCAN_ACTIVATION_THRESHOLD,
  auditObservationLogs,
  saveGraphSnapshot,
  compareWithSnapshot,
  SNAPSHOT_DIR,
  MAX_SNAPSHOTS,
  reconstructFromLogs,
  computeReconstructionConfidence,
  validateReconstructionFidelity,
  appendFidelityLog,
  tokenJaccard,
  detectMemoryGaps,
} from "./reconstruction.js";
export type {
  UncapturedSignal,
  ObservationLogEntry,
  GraphSnapshot,
  DeltaReport,
  FidelityResult,
  FidelityLogEntry,
  MemoryGap,
} from "./reconstruction.js";

// ── drift-detection.ts ──
export {
  savePinnedSnapshot,
  loadSnapshot,
  detectDrift,
  shouldAlertOnDrift,
} from "./drift-detection.js";
export type {
  PinnedNodeSnapshot,
  DriftSnapshot,
  NodeDrift,
  DriftReport,
} from "./drift-detection.js";
