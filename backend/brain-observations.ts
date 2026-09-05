/**
 * Observation queue semantics for the brain.
 *
 * observations.jsonl (append-only, written by observer.ts) IS the pending
 * queue: everything newer than `state.lastObservationTime` is unconsumed.
 * That cursor only advances when a think tick has processed the batch, so a
 * container restart never loses observations.
 *
 * Synthetic observations (recurring think triggers, digest requests) go into
 * the same file with a `synthetic` marker so they survive restarts too.
 */

import { appendFileSync } from "fs";
import { ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";
import { BrainError } from "./brain-errors.js";
import type { Observation } from "./observer.js";

const log = createLogger("brain-observations");

// Same path observer.ts appends to; observer.ts does not export it.
const OBSERVATIONS_FILE = `${BRAIN_DIR}/observations.jsonl`;

export type SyntheticKind = "recurring" | "digest";

export interface SyntheticObservation extends Observation {
  /** Marker: this line was injected by the brain itself, not observed. */
  synthetic: SyntheticKind;
}

const LEGACY_TRIGGER_PREFIX = /^\[(RECURRING TASK|DIGEST REQUEST):/;

/** A recurring/digest trigger — persisted with a marker, or a legacy in-memory one. */
export function isSyntheticTrigger(obs: Observation): boolean {
  if ((obs as Partial<SyntheticObservation>).synthetic !== undefined) return true;
  return obs.senderJid === "system" && LEGACY_TRIGGER_PREFIX.test(obs.text);
}

export function buildSyntheticObservation(
  kind: SyntheticKind,
  sender: string,
  text: string,
  now: number,
): SyntheticObservation {
  return {
    timestamp: now,
    sender,
    senderJid: "system",
    isGroup: false,
    isFromMe: true,
    text,
    source: "whatsapp",
    trustLevel: "owner",
    synthetic: kind,
  };
}

/**
 * Append a synthetic observation to observations.jsonl so it is part of the
 * durable queue. Throws a BrainError on I/O failure — a trigger the brain
 * cannot persist must not be marked executed.
 */
export function persistSyntheticObservation(obs: SyntheticObservation): void {
  try {
    ensureDir(BRAIN_DIR);
    appendFileSync(OBSERVATIONS_FILE, JSON.stringify(obs) + "\n");
    log(`Persisted synthetic ${obs.synthetic} observation (${obs.text.length} chars)`);
  } catch (err) {
    throw new BrainError(`Failed to persist synthetic observation: ${err}`, {
      phase: "observer",
      transient: true,
      metadata: { kind: obs.synthetic },
    }, err);
  }
}

/** Split the unconsumed queue into what the free observe pass has not yet seen. */
export function selectUnobserved(pending: Observation[], observedCursor: number): Observation[] {
  return pending.filter(o => o.timestamp > observedCursor);
}

/**
 * Cursor value after consuming `batch`: the newest timestamp in the batch, so
 * observations that arrived while the think was running stay queued. Falls
 * back to `previous` for an empty batch.
 */
export function consumedCursor(batch: Observation[], previous: number): number {
  return batch.reduce((max, o) => Math.max(max, o.timestamp), previous);
}
