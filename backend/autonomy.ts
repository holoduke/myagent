/**
 * Graduated Automation Trust Model (Research Improvement #12)
 *
 * Progressive autonomy levels 1-4 that determine how much independent
 * action ARIA can take. Level increases based on successful outcomes,
 * decreases on errors or negative feedback.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("autonomy");

const AUTONOMY_FILE = `${BRAIN_DIR}/autonomy-state.json`;

// ── Types ──

export type AutonomyLevel = 1 | 2 | 3 | 4;

export interface AutonomyState {
  /** Current autonomy level */
  level: AutonomyLevel;
  /** Cumulative trust score (positive increments promote, negative demote) */
  trustScore: number;
  /** Number of successful autonomous actions */
  successCount: number;
  /** Number of failed/corrected autonomous actions */
  failureCount: number;
  /** Timestamp of last level change */
  lastLevelChange: number;
  /** History of level changes */
  history: { level: AutonomyLevel; timestamp: number; reason: string }[];
}

/**
 * Autonomy level descriptions:
 * 1 - Observe Only: Watch and record, never act independently
 * 2 - Suggest: Can suggest actions but must wait for confirmation
 * 3 - Act & Report: Can take routine actions, reports afterwards
 * 4 - Full Autonomy: Can take all permitted actions independently
 */
export const LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  1: "Observe Only — watch and record, never act independently",
  2: "Suggest — suggest actions, wait for confirmation",
  3: "Act & Report — take routine actions, report afterwards",
  4: "Full Autonomy — take all permitted actions independently",
};

// Level thresholds: trust score needed to promote
const PROMOTE_THRESHOLDS: Record<number, number> = {
  1: 10,   // 10 successes to reach level 2
  2: 25,   // 25 more to reach level 3
  3: 50,   // 50 more to reach level 4
};

// ── State Management ──

let state: AutonomyState | null = null;

function loadState(): AutonomyState {
  if (state) return state;
  state = safeReadJSON<AutonomyState>(AUTONOMY_FILE, {
    level: 2,
    trustScore: 0,
    successCount: 0,
    failureCount: 0,
    lastLevelChange: Date.now(),
    history: [{ level: 2 as AutonomyLevel, timestamp: Date.now(), reason: "initial" }],
  });
  return state;
}

function saveState(): void {
  if (!state) return;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(AUTONOMY_FILE, state);
}

// ── Public API ──

/**
 * Get the current autonomy level.
 */
export function getAutonomyLevel(): AutonomyLevel {
  return loadState().level;
}

/**
 * Get full autonomy state for prompt inclusion.
 */
export function getAutonomyState(): AutonomyState {
  return { ...loadState() };
}

/**
 * Check if a specific action category is permitted at the current level.
 */
export function isActionPermitted(actionCategory: string): boolean {
  const s = loadState();

  switch (actionCategory) {
    case "observe":
      return true; // Always permitted
    case "suggest":
      return s.level >= 2;
    case "routine_action":
      return s.level >= 3;
    case "autonomous_action":
      return s.level >= 4;
    case "send_message":
      return s.level >= 2; // Can suggest messages at level 2
    case "modify_memory":
      return s.level >= 2; // Memory operations at level 2+
    case "send_proactive":
      return s.level >= 3; // Proactive messaging at level 3+
    case "self_improve":
      return s.level >= 3; // Self-improvement at level 3+
    default:
      return s.level >= 2;
  }
}

/**
 * Record a successful autonomous action (positive feedback).
 */
export function recordSuccess(action: string): void {
  const s = loadState();
  s.successCount++;
  s.trustScore++;

  // Check for promotion
  const threshold = PROMOTE_THRESHOLDS[s.level];
  if (threshold && s.trustScore >= threshold && s.level < 4) {
    const newLevel = (s.level + 1) as AutonomyLevel;
    s.history.push({
      level: newLevel,
      timestamp: Date.now(),
      reason: `Promoted: ${s.successCount} successes, trust score ${s.trustScore}`,
    });
    // Keep history bounded
    if (s.history.length > 20) {
      s.history = s.history.slice(-20);
    }
    log(`Autonomy PROMOTED: ${s.level} → ${newLevel} (trust: ${s.trustScore})`);
    s.level = newLevel;
    s.lastLevelChange = Date.now();
  }

  saveState();
}

/**
 * Record a failed or corrected autonomous action (negative feedback).
 */
export function recordFailure(action: string, reason: string): void {
  const s = loadState();
  s.failureCount++;
  s.trustScore = Math.max(0, s.trustScore - 3); // Penalty of 3 per failure

  // Check for demotion
  const totalActions = s.successCount + s.failureCount;
  if (totalActions >= 5 && s.failureCount > s.successCount * 0.3 && s.level > 1) {
    const newLevel = (s.level - 1) as AutonomyLevel;
    s.history.push({
      level: newLevel,
      timestamp: Date.now(),
      reason: `Demoted: ${reason} (failures: ${s.failureCount}/${s.successCount + s.failureCount})`,
    });
    if (s.history.length > 20) {
      s.history = s.history.slice(-20);
    }
    log(`Autonomy DEMOTED: ${s.level} → ${newLevel} — ${reason}`);
    s.level = newLevel;
    s.lastLevelChange = Date.now();
  }

  saveState();
}

/**
 * Reset state (for testing).
 */
export function resetAutonomyState(): void {
  state = null;
}

/**
 * Generate autonomy context for the brain prompt.
 */
export function getAutonomySummary(): string {
  const s = loadState();
  return `Level ${s.level}/4: ${LEVEL_DESCRIPTIONS[s.level]} (trust: ${s.trustScore}, success: ${s.successCount}, fail: ${s.failureCount})`;
}
