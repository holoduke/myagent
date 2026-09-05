/**
 * Small persistent state for the self-improve pipeline that does not belong
 * in the queue (per item) or BrainState (per tick):
 *
 *  - daily forced-reflect nudges (cap on how often the brain is pushed to propose)
 *  - the pid of the currently running improve worker (liveness checks)
 *  - the last merged self-improve PR (deterministic crash recovery target)
 *  - commits already reverted by recovery (idempotence across boot loops)
 */

import { FileStore } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("improve-state");

const STATE_FILE = `${BRAIN_DIR}/self-improve-state.json`;

export interface LastMergeRecord {
  prNumber: number;
  prUrl: string;
  mergeSha: string;
  mergedAt: number;
}

export interface SelfImproveState {
  nudge: { date: string; forcedReflects: number };
  workerPid?: number;
  lastMerge?: LastMergeRecord;
  revertedShas: string[];
}

const DEFAULT_STATE: SelfImproveState = {
  nudge: { date: "", forcedReflects: 0 },
  revertedShas: [],
};

const store = new FileStore<SelfImproveState>({ filePath: STATE_FILE, defaultValue: DEFAULT_STATE });

export function loadSelfImproveState(): SelfImproveState {
  const loaded = store.load();
  return { ...DEFAULT_STATE, ...loaded, nudge: { ...DEFAULT_STATE.nudge, ...(loaded.nudge ?? {}) } };
}

function saveSelfImproveState(state: SelfImproveState): void {
  try {
    store.save(state);
  } catch (err) {
    log(`Failed to save self-improve state: ${err}`);
    throw err;
  }
}

// ── Daily nudge counter ──

/** Pure: forced reflects already recorded for `today` (0 when the record is from another day). */
export function forcedReflectsOn(state: SelfImproveState, today: string): number {
  return state.nudge.date === today ? state.nudge.forcedReflects : 0;
}

/** Pure: state with one more forced reflect on `today`. */
export function withForcedReflect(state: SelfImproveState, today: string): SelfImproveState {
  return { ...state, nudge: { date: today, forcedReflects: forcedReflectsOn(state, today) + 1 } };
}

export function getForcedReflectsToday(today: string): number {
  return forcedReflectsOn(loadSelfImproveState(), today);
}

export function recordForcedReflect(today: string): number {
  const next = withForcedReflect(loadSelfImproveState(), today);
  saveSelfImproveState(next);
  return next.nudge.forcedReflects;
}

// ── Worker pid ──

export function setWorkerPid(pid: number | undefined): void {
  const current = loadSelfImproveState();
  const { workerPid: _drop, ...rest } = current;
  saveSelfImproveState(pid === undefined ? rest : { ...rest, workerPid: pid });
}

export function getWorkerPid(): number | undefined {
  return loadSelfImproveState().workerPid;
}

// ── Merge / recovery bookkeeping ──

export function recordLastMerge(record: LastMergeRecord): void {
  saveSelfImproveState({ ...loadSelfImproveState(), lastMerge: record });
}

export function getLastMerge(): LastMergeRecord | undefined {
  return loadSelfImproveState().lastMerge;
}

export function markShaReverted(sha: string): void {
  const current = loadSelfImproveState();
  if (current.revertedShas.includes(sha)) return;
  saveSelfImproveState({ ...current, revertedShas: [...current.revertedShas, sha].slice(-20) });
}

export function wasShaReverted(sha: string): boolean {
  return loadSelfImproveState().revertedShas.includes(sha);
}
