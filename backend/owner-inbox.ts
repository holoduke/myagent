/**
 * Owner inbox — a durable, append-only journal of inbound owner messages.
 *
 * Every owner DM is appended as a `received` record BEFORE it is handed to the
 * handler; a `done` record is appended once the reply went out. On activation
 * (after a deploy swap or crash) the entries that never reached `done` and are
 * younger than REPLAY_MAX_AGE_MS are replayed, deduped by message id.
 *
 * File: `${BRAIN_DIR}/owner-inbox.jsonl` — one JSON object per line. Appends of
 * a single short line are atomic on POSIX, which is all we need. The file is
 * compacted (rewritten with only the pending entries) on every activation.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";
import { atomicWriteFile, ensureParentDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("owner-inbox");

export const REPLAY_MAX_AGE_MS = 15 * 60 * 1000;

export interface InboxReceived {
  id: string;
  jid: string;
  text: string;
  receivedAt: number;
  status: "received";
}

export interface InboxDone {
  id: string;
  status: "done";
  doneAt: number;
}

export type InboxRecord = InboxReceived | InboxDone;

// ── Pure helpers ──

function isRecord(value: unknown): value is InboxRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (v.status === "done") return typeof v.doneAt === "number";
  if (v.status === "received") {
    return typeof v.jid === "string" && typeof v.text === "string" && typeof v.receivedAt === "number";
  }
  return false;
}

/** Parse JSONL content, skipping blank or corrupt lines. */
export function parseInbox(content: string): InboxRecord[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Entries that were received but never marked done, younger than `maxAgeMs`,
 * deduped by id (first occurrence wins), in arrival order.
 */
export function pendingEntries(
  records: InboxRecord[],
  now: number,
  maxAgeMs: number = REPLAY_MAX_AGE_MS,
): InboxReceived[] {
  const done = new Set(records.filter((r) => r.status === "done").map((r) => r.id));
  const seen = new Set<string>();
  return records.flatMap((r) => {
    if (r.status !== "received" || done.has(r.id) || seen.has(r.id)) return [];
    if (now - r.receivedAt > maxAgeMs) return [];
    seen.add(r.id);
    return [r];
  });
}

export function serializeInbox(records: InboxRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

// ── File-backed inbox ──

export interface OwnerInbox {
  readonly path: string;
  recordReceived(entry: Omit<InboxReceived, "status">): void;
  recordDone(id: string): void;
  /** Read pending entries as of `now` (does not modify the file). */
  pending(now?: number): InboxReceived[];
  /** Rewrite the file keeping only pending entries; returns them. */
  compact(now?: number): InboxReceived[];
}

export function createOwnerInbox(path: string = `${BRAIN_DIR}/owner-inbox.jsonl`): OwnerInbox {
  const readAll = (): InboxRecord[] => {
    if (!existsSync(path)) return [];
    try {
      return parseInbox(readFileSync(path, "utf-8"));
    } catch (err) {
      log.error(`Failed to read owner inbox ${path}: ${err}`);
      return [];
    }
  };

  const append = (record: InboxRecord): void => {
    try {
      ensureParentDir(path);
      appendFileSync(path, JSON.stringify(record) + "\n");
    } catch (err) {
      // Never let journaling break message handling — but be loud about it.
      log.error(`Failed to append ${record.status} record for ${record.id}: ${err}`);
    }
  };

  const pending = (now: number = Date.now()): InboxReceived[] => pendingEntries(readAll(), now);

  return {
    path,
    recordReceived: (entry) => append({ ...entry, status: "received" }),
    recordDone: (id) => append({ id, status: "done", doneAt: Date.now() }),
    pending,
    compact: (now: number = Date.now()) => {
      const keep = pending(now);
      try {
        atomicWriteFile(path, serializeInbox(keep));
      } catch (err) {
        log.error(`Failed to compact owner inbox: ${err}`);
      }
      return keep;
    },
  };
}
