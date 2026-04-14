/**
 * Metacognitive Self-Assessment (Research Improvement #14)
 * Inspired by MUSE architecture.
 *
 * Adds confidence scoring to brain decisions before acting.
 * Tracks calibration over time: are confidence scores accurate?
 */

import type { MemoryGraph } from "./memory/graph.js";
import { createLogger } from "./logger.js";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("metacognitive");

const CALIBRATION_FILE = `${BRAIN_DIR}/metacognitive-calibration.json`;

// ── Types ──

export interface ConfidenceAssessment {
  action: string;
  confidence: number; // 0.0–1.0
  reasoning: string;
  factors: ConfidenceFactor[];
}

export interface ConfidenceFactor {
  name: string;
  score: number; // 0.0–1.0
  weight: number;
}

export interface CalibrationEntry {
  confidence: number;
  wasCorrect: boolean;
  timestamp: number;
}

interface CalibrationStore {
  entries: CalibrationEntry[];
  calibrationScore: number; // how well-calibrated are predictions
}

// ── Confidence Assessment ──

/**
 * Assess confidence for a proposed action based on available context.
 */
export function assessConfidence(
  action: string,
  contextNodeCount: number,
  recentObservationCount: number,
  hasRelevantMemory: boolean,
  graph: MemoryGraph,
): ConfidenceAssessment {
  const factors: ConfidenceFactor[] = [];

  // Factor 1: Information completeness (more context = higher confidence)
  const infoScore = Math.min(1, contextNodeCount / 20);
  factors.push({ name: "information_completeness", score: infoScore, weight: 0.3 });

  // Factor 2: Recency (recent observations = more confidence)
  const recencyScore = Math.min(1, recentObservationCount / 5);
  factors.push({ name: "recency", score: recencyScore, weight: 0.25 });

  // Factor 3: Memory relevance
  const memoryScore = hasRelevantMemory ? 0.8 : 0.3;
  factors.push({ name: "memory_relevance", score: memoryScore, weight: 0.25 });

  // Factor 4: Graph health (node count, connectivity)
  const nodeCount = graph.nodeCount;
  const healthScore = nodeCount > 50 ? 0.8 : nodeCount > 10 ? 0.5 : 0.3;
  factors.push({ name: "graph_health", score: healthScore, weight: 0.2 });

  // Weighted confidence
  const confidence = factors.reduce((sum, f) => sum + f.score * f.weight, 0);

  return {
    action,
    confidence: Math.min(1, Math.max(0, confidence)),
    reasoning: formatFactorReasoning(factors),
    factors,
  };
}

function formatFactorReasoning(factors: ConfidenceFactor[]): string {
  return factors
    .sort((a, b) => b.score * b.weight - a.score * a.weight)
    .map(f => `${f.name}: ${(f.score * 100).toFixed(0)}%`)
    .join(", ");
}

// ── Calibration Tracking ──

let calibration: CalibrationStore | null = null;

function loadCalibration(): CalibrationStore {
  if (calibration) return calibration;
  calibration = safeReadJSON<CalibrationStore>(CALIBRATION_FILE, {
    entries: [],
    calibrationScore: 0.5,
  });
  return calibration;
}

function saveCalibration(): void {
  if (!calibration) return;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(CALIBRATION_FILE, calibration);
}

/**
 * Record the outcome of a confidence-assessed action.
 */
export function recordOutcome(confidence: number, wasCorrect: boolean): void {
  const c = loadCalibration();

  c.entries.push({
    confidence,
    wasCorrect,
    timestamp: Date.now(),
  });

  // Keep bounded
  if (c.entries.length > 200) {
    c.entries = c.entries.slice(-200);
  }

  // Recalculate calibration score (mean absolute error between confidence and actual accuracy)
  c.calibrationScore = computeCalibration(c.entries);

  saveCalibration();
}

/**
 * Compute calibration score: lower = better calibrated.
 * Bins predictions by confidence range, compares predicted vs actual accuracy.
 */
function computeCalibration(entries: CalibrationEntry[]): number {
  if (entries.length < 10) return 0.5; // Not enough data

  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
  let totalError = 0;
  let binCount = 0;

  for (let i = 0; i < bins.length - 1; i++) {
    const binEntries = entries.filter(e => e.confidence >= bins[i] && e.confidence < bins[i + 1]);
    if (binEntries.length < 3) continue;

    const avgConfidence = binEntries.reduce((s, e) => s + e.confidence, 0) / binEntries.length;
    const accuracy = binEntries.filter(e => e.wasCorrect).length / binEntries.length;
    totalError += Math.abs(avgConfidence - accuracy);
    binCount++;
  }

  return binCount > 0 ? Math.max(0, Math.min(1, 1 - totalError / binCount)) : 0.5;
}

/**
 * Get calibration summary for the brain prompt.
 */
export function getCalibrationSummary(): string {
  const c = loadCalibration();
  if (c.entries.length < 10) return "";

  const recent = c.entries.slice(-20);
  const recentAccuracy = recent.filter(e => e.wasCorrect).length / recent.length;

  return `Calibration: ${(c.calibrationScore * 100).toFixed(0)}% well-calibrated, recent accuracy: ${(recentAccuracy * 100).toFixed(0)}% (${recent.length} samples)`;
}

/**
 * Reset calibration state (for testing).
 */
export function resetCalibration(): void {
  calibration = null;
}
