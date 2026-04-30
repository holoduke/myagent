/**
 * Request queue for trusted contact directives.
 *
 * Tracks incoming requests from trusted contacts through their lifecycle:
 *   pending → approved/rejected/auto_executed
 *
 * Each request is linked to a directive (if one exists) and records the
 * original message, detected action type, and resolution details.
 *
 * Storage: /data/brain/request-queue.json
 */

import { randomUUID } from "crypto";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { resolvePolicy } from "./directives.js";
import type { DirectiveActionType, DirectivePolicy } from "./directives.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("request-queue");


const QUEUE_FILE = `${BRAIN_DIR}/request-queue.json`;

export type RequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "auto_executed";

export interface ContactRequest {
  id: string;
  timestamp: number;
  /** Sender JID */
  contactJid: string;
  /** Human-readable sender name */
  contactName: string;
  /** Original message text */
  message: string;
  /** Detected action type */
  actionType: DirectiveActionType;
  /** Extracted action details (e.g. event date, reminder text) */
  actionSummary: string;
  /** Current status */
  status: RequestStatus;
  /** Which policy was applied */
  appliedPolicy: DirectivePolicy | "no-directive";
  /** Whether this came from a group chat */
  isGroup: boolean;
  groupName?: string;
  /** When the request was resolved (approved/rejected/executed) */
  resolvedAt?: number;
  /** Optional note from owner when approving/rejecting */
  resolutionNote?: string;
}

// ── Write-through cache ──

let cache: ContactRequest[] | null = null;

function load(): ContactRequest[] {
  if (cache) return cache;
  cache = safeReadJSON<ContactRequest[]>(QUEUE_FILE, []);
  return cache;
}

function save(requests: ContactRequest[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(QUEUE_FILE, requests);
  cache = requests;
}

// ── Core functions ──

/**
 * Enqueue a new request from a trusted contact.
 * Automatically resolves the directive policy and sets initial status.
 */
export function enqueueRequest(params: {
  contactJid: string;
  contactName: string;
  message: string;
  actionType: DirectiveActionType;
  actionSummary: string;
  isGroup: boolean;
  groupName?: string;
}): ContactRequest {
  const policy = resolvePolicy(params.contactJid, params.actionType);
  const status: RequestStatus = policy === "auto-execute" ? "auto_executed" : "pending";
  const appliedPolicy = policy ?? "no-directive";

  const request: ContactRequest = {
    id: `req_${randomUUID().slice(0, 8)}`,
    timestamp: Date.now(),
    contactJid: params.contactJid,
    contactName: params.contactName,
    message: params.message,
    actionType: params.actionType,
    actionSummary: params.actionSummary,
    status,
    appliedPolicy,
    isGroup: params.isGroup,
    groupName: params.groupName,
  };

  if (status === "auto_executed") {
    request.resolvedAt = Date.now();
  }

  const requests = load();
  requests.push(request);
  save(requests);

  log(`Enqueued ${status} request from ${params.contactName}: ${params.actionType} — "${params.actionSummary.slice(0, 80)}"`);
  return request;
}

/**
 * Get all requests, optionally filtered by status.
 */
export function getRequests(statusFilter?: RequestStatus): ContactRequest[] {
  const all = load();
  if (!statusFilter) return all;
  return all.filter(r => r.status === statusFilter);
}

/**
 * Get a single request by ID.
 */
export function getRequest(id: string): ContactRequest | undefined {
  return load().find(r => r.id === id);
}

/**
 * Approve a pending request.
 */
export function approveRequest(id: string, note?: string): ContactRequest {
  const requests = load();
  const req = requests.find(r => r.id === id);
  if (!req) throw new Error(`Request ${id} not found`);
  if (req.status !== "pending") throw new Error(`Request ${id} is ${req.status}, not pending`);
  req.status = "approved";
  req.resolvedAt = Date.now();
  if (note) req.resolutionNote = note;
  save(requests);
  log(`Approved request ${id} from ${req.contactName}`);
  return req;
}

/**
 * Reject a pending request.
 */
export function rejectRequest(id: string, note?: string): ContactRequest {
  const requests = load();
  const req = requests.find(r => r.id === id);
  if (!req) throw new Error(`Request ${id} not found`);
  if (req.status !== "pending") throw new Error(`Request ${id} is ${req.status}, not pending`);
  req.status = "rejected";
  req.resolvedAt = Date.now();
  if (note) req.resolutionNote = note;
  save(requests);
  log(`Rejected request ${id} from ${req.contactName}`);
  return req;
}

/**
 * Count pending requests.
 */
export function getPendingRequestCount(): number {
  return load().filter(r => r.status === "pending").length;
}

/**
 * Prune old resolved requests (keep last N days, always keep pending).
 */
export function pruneRequests(daysToKeep = 30): number {
  const cutoff = Date.now() - daysToKeep * 86400000;
  const requests = load();
  const kept = requests.filter(r =>
    r.status === "pending" || r.timestamp > cutoff,
  );
  const pruned = requests.length - kept.length;
  if (pruned > 0) {
    save(kept);
    log(`Pruned ${pruned} old requests`);
  }
  return pruned;
}
