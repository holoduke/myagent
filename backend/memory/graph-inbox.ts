/**
 * Graph-ops inbox — how every process that is *not* the brain writes memory.
 *
 * The brain owns the graph files (single writer, see graph-persistence.ts).
 * Other writers (web API, chat provider, self-improve workers) append their
 * intended operations to `${BRAIN_DIR}/graph-inbox.jsonl` and the brain
 * applies them at boot and at the start of every tick.
 *
 * Draining is rename-then-read: the live file is renamed to a unique
 * `.draining` file first, so appends that race the drain land in a fresh
 * inbox instead of being lost; leftover `.draining` files from a crash are
 * picked up on the next drain.
 *
 * The same directory also carries `reload-requested`, a marker written by
 * restore-from-backup that tells the brain to reload the graph from disk
 * before doing anything else.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { randomBytes } from "crypto";
import type { MemoryGraph } from "./graph.js";
import type { MemoryOperation, GoalOperation } from "./types.js";
import { GoalTracker } from "../goals.js";
import { readJsonl } from "../utils/file-store.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";

const log = createLogger("graph-inbox");

export const GRAPH_INBOX_FILE = `${BRAIN_DIR}/graph-inbox.jsonl`;
export const RELOAD_MARKER_FILE = `${BRAIN_DIR}/reload-requested`;
const DRAINING_SUFFIX = ".draining";

export interface GraphInboxEntry {
  ts: number;
  source: string;
  ops?: MemoryOperation[];
  goalOps?: GoalOperation[];
}

export interface DrainResult {
  entries: number;
  applied: number;
  skipped: number;
  malformed: number;
}

function ensureBrainDir(): void {
  if (!existsSync(BRAIN_DIR)) mkdirSync(BRAIN_DIR, { recursive: true });
}

/**
 * Queue memory operations for the brain. One line per call, written with a
 * single O_APPEND write so concurrent appenders never interleave. Throws when
 * the append fails — callers decide whether that is fatal for them.
 */
export function appendGraphOps(ops: MemoryOperation[], source: string, goalOps?: GoalOperation[]): void {
  if (ops.length === 0 && (!goalOps || goalOps.length === 0)) return;
  ensureBrainDir();
  const entry: GraphInboxEntry = {
    ts: Date.now(),
    source,
    ...(ops.length > 0 ? { ops } : {}),
    ...(goalOps && goalOps.length > 0 ? { goalOps } : {}),
  };
  appendFileSync(GRAPH_INBOX_FILE, JSON.stringify(entry) + "\n", "utf-8");
  log(`Queued ${ops.length} op(s)${goalOps?.length ? ` + ${goalOps.length} goal op(s)` : ""} from ${source}`);
}

/** Leftover `.draining` files (crash mid-drain), oldest first, then the live inbox if present. */
function collectDrainFiles(): string[] {
  const dir = dirname(GRAPH_INBOX_FILE);
  const name = basename(GRAPH_INBOX_FILE);
  let leftovers: string[] = [];
  try {
    leftovers = readdirSync(dir)
      .filter(f => f.startsWith(name + ".") && f.endsWith(DRAINING_SUFFIX))
      .sort()
      .map(f => join(dir, f));
  } catch (err) {
    log(`Could not list inbox directory: ${err}`);
  }
  if (!existsSync(GRAPH_INBOX_FILE)) return leftovers;
  const draining = `${GRAPH_INBOX_FILE}.${Date.now()}.${process.pid}.${randomBytes(3).toString("hex")}${DRAINING_SUFFIX}`;
  try {
    renameSync(GRAPH_INBOX_FILE, draining);
    return [...leftovers, draining];
  } catch (err) {
    log(`Could not rename inbox for draining: ${err}`);
    return leftovers;
  }
}

function applyEntry(graph: MemoryGraph, entry: GraphInboxEntry): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;
  if (Array.isArray(entry.ops)) {
    const result = graph.applyOperations(entry.ops);
    applied += result.applied;
    skipped += result.skipped + result.dropped;
  }
  if (Array.isArray(entry.goalOps)) {
    const result = new GoalTracker(graph).applyGoalOps(entry.goalOps);
    applied += result.applied;
    skipped += result.failed;
  }
  return { applied, skipped };
}

/** Apply every queued entry to `graph` and delete the drained files. Never throws. */
export function drainGraphInbox(graph: MemoryGraph): DrainResult {
  const totals: DrainResult = { entries: 0, applied: 0, skipped: 0, malformed: 0 };
  for (const file of collectDrainFiles()) {
    const { entries, malformed } = readJsonl<GraphInboxEntry>(file);
    totals.malformed += malformed;
    for (const entry of entries) {
      totals.entries++;
      try {
        const { applied, skipped } = applyEntry(graph, entry);
        totals.applied += applied;
        totals.skipped += skipped;
      } catch (err) {
        totals.skipped++;
        log(`Inbox entry from ${entry.source ?? "?"} failed: ${err}`);
      }
    }
    try {
      unlinkSync(file);
    } catch (err) {
      log(`Could not delete drained inbox file ${file}: ${err}`);
    }
  }
  if (totals.entries > 0 || totals.malformed > 0) {
    log(`Drained inbox: ${totals.entries} entries, ${totals.applied} applied, ${totals.skipped} skipped, ${totals.malformed} malformed`);
  }
  return totals;
}

/** Ask the brain to reload the graph from disk before its next tick. */
export function requestGraphReload(reason: string): void {
  ensureBrainDir();
  appendFileSync(RELOAD_MARKER_FILE, `${new Date().toISOString()} ${reason}\n`, "utf-8");
}

/** Consume the reload marker; true when a reload was requested. */
export function consumeReloadRequest(): boolean {
  if (!existsSync(RELOAD_MARKER_FILE)) return false;
  try {
    unlinkSync(RELOAD_MARKER_FILE);
  } catch (err) {
    log(`Could not remove reload marker: ${err}`);
  }
  return true;
}
