/**
 * Brain state persistence — /data/brain/state.json.
 *
 * The state file is written by several independent actors (the tick loop, the
 * 10s scheduler poller, fire-and-forget digests, self-improve workers). Any
 * actor that saves a whole snapshot it loaded earlier silently reverts every
 * field another actor changed in between. `patchState` is the safe primitive:
 * it re-reads the file at the moment of change and writes only the delta.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";
import type { BrainState } from "./memory/types.js";

const log = createLogger("brain-state");

export const STATE_FILE = `${BRAIN_DIR}/state.json`;

export function defaultState(): BrainState {
  return {
    lastObserveTick: 0,
    lastThinkTick: 0,
    lastConsolidateTick: 0,
    lastReflectTick: 0,
    lastMessageTime: 0,
    messagesToday: 0,
    messagesTodayDate: "",
    lastObservationTime: 0,
    totalThinks: 0,
    totalCost: 0,
    nodeCount: 0,
    edgeCount: 0,
    recurringThinksToday: 0,
    recurringBudgetDate: "",
    initiativeThinksToday: 0,
    initiativeBudgetDate: "",
    consecutiveFailures: 0,
    lastSuccessfulTick: 0,
    pendingSelfMod: false,
    lastBackupTick: 0,
    lastNewsDigestTick: 0,
    lastPlayStoreDigestTick: 0,
  };
}

export function loadState(): BrainState {
  return { ...defaultState(), ...safeReadJSON<Partial<BrainState>>(STATE_FILE, {}) };
}

/**
 * Overwrite the whole state file. Prefer `patchState` — this exists for the
 * legacy snapshot callers (self-improve worker bookkeeping) that mutate a
 * freshly loaded state and save it straight back.
 */
export function saveState(state: BrainState): void {
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(STATE_FILE, state);
  } catch (err) {
    log(`Failed to save state: ${err}`);
  }
}

/** A partial update, or a function deriving one from the current on-disk state. */
export type StatePatch = Partial<BrainState> | ((current: BrainState) => Partial<BrainState>);

/**
 * Read-modify-write at the moment of change. Returns the new state so callers
 * can keep working with an up-to-date copy instead of a stale snapshot.
 */
export function patchState(patch: StatePatch): BrainState {
  const current = loadState();
  const delta = typeof patch === "function" ? patch(current) : patch;
  const next: BrainState = { ...current, ...delta };
  saveState(next);
  return next;
}
