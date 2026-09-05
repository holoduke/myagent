import { randomUUID } from "node:crypto";
import { FileStore } from "./utils/file-store.js";
import type { ImprovementTask } from "./self-improve-prompt.js";
import { getBrainConfig, getOwnerLocalDate } from "./brain-config.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("improve-queue");


const QUEUE_FILE = `${BRAIN_DIR}/improve-queue.json`;
const HISTORY_FILE = `${BRAIN_DIR}/improve-history.json`;
const MAX_HISTORY = 50;

// ── Types ──

export interface ImproveResult {
  success: boolean;
  description: string;
  prUrl?: string;
  branch?: string;
  wasRollback?: boolean;
  intent?: { summary: string; tokens: string[]; hash: string };
  /** Tail of the verification / merge output when the merge step failed. */
  mergeError?: string;
}

export type QueueItemStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "running"
  | "merge-pending"   // worker done, PR open, waiting for a verified merge slot
  | "merge-failed"    // verification/merge failed — retried with backoff, then closed
  | "completed"
  | "failed";

export interface QueueItem {
  id: string;
  task: ImprovementTask;
  status: QueueItemStatus;
  createdAt: number;
  reviewedAt?: number;
  completedAt?: number;
  /** When the PR was merged (only set for merged items). */
  mergedAt?: number;
  /** Verified-merge attempts so far (merge-pending / merge-failed items). */
  mergeAttempts?: number;
  /** Earliest time the next merge attempt may run (backoff). */
  nextMergeAttemptAt?: number;
  result?: ImproveResult;
}

export interface ImproveQueue {
  items: QueueItem[];
}

export interface ImproveHistory {
  entries: QueueItem[];
}

// ── Persistence ──

const queueStore = new FileStore<ImproveQueue>({ filePath: QUEUE_FILE, defaultValue: { items: [] } });
const historyStore = new FileStore<ImproveHistory>({ filePath: HISTORY_FILE, defaultValue: { entries: [] } });

export function loadQueue(): ImproveQueue {
  return queueStore.load();
}

export function saveQueue(queue: ImproveQueue): void {
  try {
    queueStore.save(queue);
  } catch (err) {
    log(`Failed to save queue: ${err}`);
    throw err;
  }
}

export function loadHistory(): ImproveHistory {
  return historyStore.load();
}

export function saveHistory(history: ImproveHistory): void {
  try {
    // Cap at MAX_HISTORY entries
    const capped = history.entries.length > MAX_HISTORY
      ? { entries: history.entries.slice(0, MAX_HISTORY) }
      : history;
    historyStore.save(capped);
  } catch (err) {
    log(`Failed to save history: ${err}`);
    throw err;
  }
}

// ── Internal helpers ──

function newItem(task: ImprovementTask, status: "pending" | "approved"): QueueItem {
  const now = Date.now();
  return {
    id: `si_${randomUUID()}`,
    task,
    status,
    createdAt: now,
    ...(status === "approved" ? { reviewedAt: now } : {}),
  };
}

/** Persist a replacement for the item at `idx` (immutable update of the queue). */
function replaceItem(queue: ImproveQueue, idx: number, next: QueueItem): ImproveQueue {
  const items = queue.items.map((it, i) => (i === idx ? next : it));
  const updated = { items };
  saveQueue(updated);
  return updated;
}

function moveToHistory(queue: ImproveQueue, idx: number): QueueItem {
  const item = queue.items[idx];
  // Save to history FIRST — worst case is a harmless duplicate, not data loss
  const history = loadHistory();
  saveHistory({ entries: [item, ...history.entries] });
  // Only remove from queue after history is safely persisted
  saveQueue({ items: queue.items.filter((_, i) => i !== idx) });
  return item;
}

// ── Queue Operations ──

export function enqueue(task: ImprovementTask): QueueItem {
  const queue = loadQueue();
  const item = newItem(task, "pending");
  saveQueue({ items: [...queue.items, item] });
  log(`Enqueued: ${item.id} — ${task.description.slice(0, 80)}`);
  return item;
}

/**
 * Enqueue a task as pre-approved. Used for brain-originated proposals
 * when selfImproveAutoApprove is on; otherwise proposals wait for review.
 */
export function enqueueApproved(task: ImprovementTask): QueueItem {
  const queue = loadQueue();
  const item = newItem(task, "approved");
  saveQueue({ items: [...queue.items, item] });
  log(`Enqueued (pre-approved): ${item.id} — ${task.description.slice(0, 80)}`);
  return item;
}

export function approveItem(id: string): QueueItem {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error(`Queue item not found: ${id}`);
  const item = queue.items[idx];
  if (item.status !== "pending") throw new Error(`Cannot approve item with status: ${item.status}`);
  const next: QueueItem = { ...item, status: "approved", reviewedAt: Date.now() };
  replaceItem(queue, idx, next);
  log(`Approved: ${id}`);
  return next;
}

export function rejectItem(id: string): QueueItem {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error(`Queue item not found: ${id}`);
  const item = queue.items[idx];
  if (item.status !== "pending") throw new Error(`Cannot reject item with status: ${item.status}`);
  const next: QueueItem = { ...item, status: "rejected", reviewedAt: Date.now() };
  const updated = replaceItem(queue, idx, next);
  moveToHistory(updated, idx);
  log(`Rejected: ${id}`);
  return next;
}

export function dequeueApproved(): QueueItem | null {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.status === "approved");
  if (idx === -1) return null;
  const next: QueueItem = { ...queue.items[idx], status: "running" };
  replaceItem(queue, idx, next);
  log(`Dequeued for execution: ${next.id}`);
  return next;
}

/** Finish an item as completed. Returns false when the item is no longer in the queue. */
export function completeItem(id: string, result: ImproveResult, mergedAt?: number): boolean {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    log(`completeItem: item ${id} not found in queue`);
    return false;
  }
  const now = Date.now();
  const next: QueueItem = { ...queue.items[idx], status: "completed", completedAt: now, mergedAt, result };
  moveToHistory(replaceItem(queue, idx, next), idx);
  log(`Completed: ${id}`);
  return true;
}

/** Finish an item as failed. Returns false when the item is no longer in the queue. */
export function failItem(id: string, result: ImproveResult): boolean {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    log(`failItem: item ${id} not found in queue`);
    return false;
  }
  const next: QueueItem = { ...queue.items[idx], status: "failed", completedAt: Date.now(), result };
  moveToHistory(replaceItem(queue, idx, next), idx);
  log(`Failed: ${id}`);
  return true;
}

/**
 * Park a finished worker result until a verified merge slot opens.
 * Returns false when the item vanished (deleted from the dashboard meanwhile).
 */
export function markMergePending(id: string, result: ImproveResult): boolean {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    log(`markMergePending: item ${id} not found in queue`);
    return false;
  }
  const next: QueueItem = {
    ...queue.items[idx],
    status: "merge-pending",
    result,
    mergeAttempts: 0,
    nextMergeAttemptAt: Date.now(),
  };
  replaceItem(queue, idx, next);
  log(`Merge pending: ${id} (${result.prUrl ?? "no PR"})`);
  return true;
}

/** Record a failed verified-merge attempt and schedule the next one. */
export function recordMergeFailure(id: string, mergeError: string, nextAttemptAt: number): QueueItem | null {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    log(`recordMergeFailure: item ${id} not found in queue`);
    return null;
  }
  const item = queue.items[idx];
  const next: QueueItem = {
    ...item,
    status: "merge-failed",
    mergeAttempts: (item.mergeAttempts ?? 0) + 1,
    nextMergeAttemptAt: nextAttemptAt,
    result: item.result ? { ...item.result, mergeError } : { success: false, description: "", mergeError },
  };
  replaceItem(queue, idx, next);
  log(`Merge failed: ${id} (attempt ${next.mergeAttempts})`);
  return next;
}

/** Items waiting for a merge whose backoff has elapsed, oldest first. Pure core. */
export function selectMergeCandidates(items: readonly QueueItem[], now: number): QueueItem[] {
  return items
    .filter(i => (i.status === "merge-pending" || i.status === "merge-failed") && (i.nextMergeAttemptAt ?? 0) <= now)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getMergeCandidates(now: number = Date.now()): QueueItem[] {
  return selectMergeCandidates(loadQueue().items, now);
}

export function getQueueItem(id: string): QueueItem | null {
  return loadQueue().items.find(i => i.id === id) ?? null;
}

/**
 * Remove an item from the queue. Returns false (and leaves it) while the
 * worker is running — the result pickup would otherwise route to nothing.
 * Throws when the item does not exist.
 */
export function deleteItem(id: string): boolean {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error(`Queue item not found: ${id}`);
  if (queue.items[idx].status === "running") {
    log(`Refusing to delete running item ${id}`);
    return false;
  }
  saveQueue({ items: queue.items.filter((_, i) => i !== idx) });
  log(`Deleted: ${id}`);
  return true;
}

// ── Budget queries ──

export function getWeeklyCompletedCount(): number {
  const history = loadHistory();
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return history.entries.filter(
    e => e.status === "completed" && e.completedAt && e.completedAt > oneWeekAgo,
  ).length;
}

type LocalDateOf = (ms: number) => string;

/** Completed improvements in the current owner-local day. Pure core exported for tests. */
export function countCompletedOnDay(entries: readonly QueueItem[], localDateOf: LocalDateOf, today: string): number {
  return entries.filter(
    e => e.status === "completed" && e.completedAt && localDateOf(e.completedAt) === today,
  ).length;
}

/**
 * Completed + failed attempts today. This is the daily *budget* counter:
 * a failed run burned a worker slot (and possibly a PR) just like a merge did.
 */
export function countAttemptsOnDay(entries: readonly QueueItem[], localDateOf: LocalDateOf, today: string): number {
  return entries.filter(
    e => (e.status === "completed" || e.status === "failed") && e.completedAt && localDateOf(e.completedAt) === today,
  ).length;
}

/**
 * Consecutive failures at the head of history (newest first) that happened
 * today. Stops at the first non-failed entry. Pure core.
 */
export function countConsecutiveFailuresToday(entries: readonly QueueItem[], localDateOf: LocalDateOf, today: string): number {
  let count = 0;
  for (const e of entries) {
    if (e.status === "rejected") continue; // reviewer decisions are not worker outcomes
    if (e.status !== "failed" || !e.completedAt || localDateOf(e.completedAt) !== today) break;
    count++;
  }
  return count;
}

/** Timestamp of the most recent merged item, or 0 when none. Pure core. */
export function findLastMergeAt(entries: readonly QueueItem[]): number {
  return entries.reduce((max, e) => Math.max(max, e.mergedAt ?? 0), 0);
}

function ownerLocalDateOf(): { localDateOf: LocalDateOf; today: string } {
  const { ownerTimezone } = getBrainConfig();
  return {
    localDateOf: (ms: number) => getOwnerLocalDate(ownerTimezone, new Date(ms)),
    today: getOwnerLocalDate(ownerTimezone),
  };
}

export function getDailyCompletedCount(): number {
  const { localDateOf, today } = ownerLocalDateOf();
  return countCompletedOnDay(loadHistory().entries, localDateOf, today);
}

export function getDailyAttemptCount(): number {
  const { localDateOf, today } = ownerLocalDateOf();
  return countAttemptsOnDay(loadHistory().entries, localDateOf, today);
}

export function getConsecutiveFailuresToday(): number {
  const { localDateOf, today } = ownerLocalDateOf();
  return countConsecutiveFailuresToday(loadHistory().entries, localDateOf, today);
}

export function getLastMergeAt(): number {
  return findLastMergeAt(loadHistory().entries);
}
