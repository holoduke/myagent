import { randomUUID } from "node:crypto";
import { FileStore } from "./utils/file-store.js";
import type { ImprovementTask } from "./self-improve-prompt.js";
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
}

export interface QueueItem {
  id: string;
  task: ImprovementTask;
  status: "pending" | "approved" | "rejected" | "running" | "completed" | "failed";
  createdAt: number;
  reviewedAt?: number;
  completedAt?: number;
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
    if (history.entries.length > MAX_HISTORY) {
      history.entries = history.entries.slice(0, MAX_HISTORY);
    }
    historyStore.save(history);
  } catch (err) {
    log(`Failed to save history: ${err}`);
    throw err;
  }
}

// ── Queue Operations ──

export function enqueue(task: ImprovementTask): QueueItem {
  const queue = loadQueue();
  const item: QueueItem = {
    id: `si_${randomUUID()}`,
    task,
    status: "pending",
    createdAt: Date.now(),
  };
  queue.items.push(item);
  saveQueue(queue);
  log(`Enqueued: ${item.id} — ${task.description.slice(0, 80)}`);
  return item;
}

/**
 * Enqueue a task as pre-approved. Used for brain-originated proposals
 * that have already been through the brain's deliberation process.
 * These bypass the manual approval step without needing selfImproveAutoApprove.
 */
export function enqueueApproved(task: ImprovementTask): QueueItem {
  const queue = loadQueue();
  const now = Date.now();
  const item: QueueItem = {
    id: `si_${randomUUID()}`,
    task,
    status: "approved",
    createdAt: now,
    reviewedAt: now,
  };
  queue.items.push(item);
  saveQueue(queue);
  log(`Enqueued (pre-approved): ${item.id} — ${task.description.slice(0, 80)}`);
  return item;
}

export function approveItem(id: string): QueueItem {
  const queue = loadQueue();
  const item = queue.items.find(i => i.id === id);
  if (!item) throw new Error(`Queue item not found: ${id}`);
  if (item.status !== "pending") throw new Error(`Cannot approve item with status: ${item.status}`);
  item.status = "approved";
  item.reviewedAt = Date.now();
  saveQueue(queue);
  log(`Approved: ${id}`);
  return item;
}

function moveToHistory(queue: ImproveQueue, idx: number): QueueItem {
  const item = queue.items[idx];
  // Save to history FIRST — worst case is a harmless duplicate, not data loss
  const history = loadHistory();
  history.entries.unshift(item);
  saveHistory(history);
  // Only remove from queue after history is safely persisted
  queue.items.splice(idx, 1);
  saveQueue(queue);
  return item;
}

export function rejectItem(id: string): QueueItem {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error(`Queue item not found: ${id}`);
  const item = queue.items[idx];
  if (item.status !== "pending") throw new Error(`Cannot reject item with status: ${item.status}`);
  item.status = "rejected";
  item.reviewedAt = Date.now();
  moveToHistory(queue, idx);
  log(`Rejected: ${id}`);
  return item;
}

export function dequeueApproved(): QueueItem | null {
  const queue = loadQueue();
  const item = queue.items.find(i => i.status === "approved");
  if (!item) return null;
  item.status = "running";
  saveQueue(queue);
  log(`Dequeued for execution: ${item.id}`);
  return item;
}

export function completeItem(id: string, result: ImproveResult): void {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    log(`completeItem: item ${id} not found in queue`);
    return;
  }
  const item = queue.items[idx];
  item.status = "completed";
  item.completedAt = Date.now();
  item.result = result;
  moveToHistory(queue, idx);
  log(`Completed: ${id}`);
}

export function failItem(id: string, result: ImproveResult): void {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) {
    log(`failItem: item ${id} not found in queue`);
    return;
  }
  const item = queue.items[idx];
  item.status = "failed";
  item.completedAt = Date.now();
  item.result = result;
  moveToHistory(queue, idx);
  log(`Failed: ${id}`);
}

export function deleteItem(id: string): void {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error(`Queue item not found: ${id}`);
  queue.items.splice(idx, 1);
  saveQueue(queue);
  log(`Deleted: ${id}`);
}

export function getWeeklyCompletedCount(): number {
  const history = loadHistory();
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return history.entries.filter(
    e => e.status === "completed" && e.completedAt && e.completedAt > oneWeekAgo,
  ).length;
}

