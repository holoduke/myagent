import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import type { ImprovementTask } from "./self-improve-prompt.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [improve-queue] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
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

function ensureDir(): void {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

export function loadQueue(): ImproveQueue {
  try {
    if (existsSync(QUEUE_FILE)) {
      return JSON.parse(readFileSync(QUEUE_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load queue: ${err}`);
  }
  return { items: [] };
}

export function saveQueue(queue: ImproveQueue): void {
  ensureDir();
  const tmp = QUEUE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(queue, null, 2));
  renameSync(tmp, QUEUE_FILE);
}

export function loadHistory(): ImproveHistory {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load history: ${err}`);
  }
  return { entries: [] };
}

export function saveHistory(history: ImproveHistory): void {
  ensureDir();
  // Cap at MAX_HISTORY entries
  if (history.entries.length > MAX_HISTORY) {
    history.entries = history.entries.slice(0, MAX_HISTORY);
  }
  const tmp = HISTORY_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(history, null, 2));
  renameSync(tmp, HISTORY_FILE);
}

// ── Queue Operations ──

export function enqueue(task: ImprovementTask): QueueItem {
  const queue = loadQueue();
  const item: QueueItem = {
    id: `si_${Date.now()}`,
    task,
    status: "pending",
    createdAt: Date.now(),
  };
  queue.items.push(item);
  saveQueue(queue);
  log(`Enqueued: ${item.id} — ${task.description.slice(0, 80)}`);
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

export function rejectItem(id: string): QueueItem {
  const queue = loadQueue();
  const idx = queue.items.findIndex(i => i.id === id);
  if (idx === -1) throw new Error(`Queue item not found: ${id}`);
  const item = queue.items[idx];
  if (item.status !== "pending") throw new Error(`Cannot reject item with status: ${item.status}`);
  item.status = "rejected";
  item.reviewedAt = Date.now();
  // Move to history
  queue.items.splice(idx, 1);
  saveQueue(queue);
  const history = loadHistory();
  history.entries.unshift(item);
  saveHistory(history);
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
  // Move to history
  queue.items.splice(idx, 1);
  saveQueue(queue);
  const history = loadHistory();
  history.entries.unshift(item);
  saveHistory(history);
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
  // Move to history
  queue.items.splice(idx, 1);
  saveQueue(queue);
  const history = loadHistory();
  history.entries.unshift(item);
  saveHistory(history);
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
