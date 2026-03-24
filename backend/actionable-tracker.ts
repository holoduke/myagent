/**
 * Actionable request tracker.
 *
 * Persists actionable requests from whitelisted contacts to disk.
 * Each request has a status based on the contact's permission rules:
 * - auto_executed: acted on silently (e.g. event tracked)
 * - pending_confirmation: waiting for owner approval
 * - approved / rejected: owner decided
 *
 * Follows the scheduler.ts write-through cache pattern.
 */

import { randomUUID } from "crypto";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { getActionMode } from "./contact-whitelist.js";
import type { ActionableSignal, ActionableCategory } from "./actionable.js";
import type { Observation } from "./observer.js";

const log = createLogger("actionable-tracker");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const REQUESTS_FILE = `${BRAIN_DIR}/actionable-requests.json`;

export type ActionableRequestStatus =
  | "auto_executed"
  | "pending_confirmation"
  | "approved"
  | "rejected";

export interface ActionableRequest {
  id: string;
  timestamp: number;
  senderJid: string;
  senderName: string;
  chatName?: string;
  isGroup: boolean;
  groupName?: string;
  text: string;
  signals: ActionableSignal[];
  categories: ActionableCategory[];
  status: ActionableRequestStatus;
  resolvedAt?: number;
}

// ── Write-through cache ──

let cache: ActionableRequest[] | null = null;

function load(): ActionableRequest[] {
  if (cache) return cache;
  cache = safeReadJSON<ActionableRequest[]>(REQUESTS_FILE, []);
  return cache;
}

function save(requests: ActionableRequest[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(REQUESTS_FILE, requests);
  cache = requests;
}

// ── Core functions ──

/**
 * Process an observation that has actionable signals.
 * Determines status per signal category and creates a tracked request.
 */
export function processObservation(obs: Observation): void {
  if (!obs.actionableSignals || obs.actionableSignals.length === 0) return;

  let hasConfirm = false;
  let hasAuto = false;
  const keptSignals: ActionableSignal[] = [];

  for (const signal of obs.actionableSignals) {
    const mode = getActionMode(obs.senderJid, signal.category);
    if (mode === "ignore") continue;
    if (mode === "confirm") hasConfirm = true;
    if (mode === "auto") hasAuto = true;
    keptSignals.push(signal);
  }

  // All signals were ignored
  if (keptSignals.length === 0) return;

  // Most restrictive mode wins
  const status: ActionableRequestStatus = hasConfirm ? "pending_confirmation" : "auto_executed";
  const categories = [...new Set(keptSignals.map(s => s.category))];

  const request: ActionableRequest = {
    id: `areq_${randomUUID().slice(0, 8)}`,
    timestamp: obs.timestamp || Date.now(),
    senderJid: obs.senderJid,
    senderName: obs.sender,
    chatName: obs.chatName,
    isGroup: obs.isGroup,
    groupName: obs.groupName,
    text: obs.text,
    signals: keptSignals,
    categories,
    status,
  };

  const requests = load();
  requests.push(request);
  save(requests);

  log(`Tracked ${status} request from ${obs.sender}: ${categories.join(", ")} — "${obs.text.slice(0, 80)}"`);
}

/**
 * Get all tracked requests, optionally filtered by status.
 */
export function getActionableRequests(statusFilter?: ActionableRequestStatus): ActionableRequest[] {
  const all = load();
  if (!statusFilter) return all;
  return all.filter(r => r.status === statusFilter);
}

/**
 * Approve a pending request.
 */
export function approveRequest(id: string): ActionableRequest {
  const requests = load();
  const req = requests.find(r => r.id === id);
  if (!req) throw new Error(`Request ${id} not found`);
  if (req.status !== "pending_confirmation") throw new Error(`Request ${id} is ${req.status}, not pending`);
  req.status = "approved";
  req.resolvedAt = Date.now();
  save(requests);
  log(`Approved request ${id} from ${req.senderName}`);
  return req;
}

/**
 * Reject a pending request.
 */
export function rejectRequest(id: string): ActionableRequest {
  const requests = load();
  const req = requests.find(r => r.id === id);
  if (!req) throw new Error(`Request ${id} not found`);
  if (req.status !== "pending_confirmation") throw new Error(`Request ${id} is ${req.status}, not pending`);
  req.status = "rejected";
  req.resolvedAt = Date.now();
  save(requests);
  log(`Rejected request ${id} from ${req.senderName}`);
  return req;
}

/**
 * Create a pending request from a brain-flagged message.
 * Used by the think tick when the brain judges a message from a
 * non-permissioned contact needs owner attention.
 */
export function createFlaggedRequest(flag: {
  senderName: string;
  senderJid: string;
  text: string;
  reason: string;
  categories: string[];
  isGroup?: boolean;
  groupName?: string;
}): ActionableRequest {
  const request: ActionableRequest = {
    id: `areq_${randomUUID().slice(0, 8)}`,
    timestamp: Date.now(),
    senderJid: flag.senderJid,
    senderName: flag.senderName,
    isGroup: flag.isGroup || false,
    groupName: flag.groupName,
    text: flag.text,
    signals: flag.categories.map(c => ({ category: c as any, snippet: flag.reason, pattern: "brain-flagged" })),
    categories: flag.categories as any[],
    status: "pending_confirmation",
  };

  const requests = load();

  // Deduplicate: skip if same sender + similar text already pending
  const isDupe = requests.some(r =>
    r.status === "pending_confirmation" &&
    r.senderJid === flag.senderJid &&
    r.text === flag.text,
  );
  if (isDupe) {
    log(`Skipped duplicate flagged request from ${flag.senderName}`);
    return request;
  }

  requests.push(request);
  save(requests);
  log(`Brain-flagged request from ${flag.senderName}: "${flag.text.slice(0, 80)}" (${flag.reason})`);
  return request;
}

/**
 * Count pending requests (useful for dashboard badge).
 */
export function getPendingCount(): number {
  return load().filter(r => r.status === "pending_confirmation").length;
}

/**
 * Prune old resolved requests (keep last N days).
 */
export function pruneRequests(daysToKeep = 30): number {
  const cutoff = Date.now() - daysToKeep * 86400000;
  const requests = load();
  const kept = requests.filter(r =>
    r.status === "pending_confirmation" || r.timestamp > cutoff,
  );
  const pruned = requests.length - kept.length;
  if (pruned > 0) {
    save(kept);
    log(`Pruned ${pruned} old actionable requests`);
  }
  return pruned;
}
