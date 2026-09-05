import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { existsSync, statSync, openSync, closeSync, unlinkSync } from "fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import { isWhitelisted, resolveCanonicalJid } from "./contact-whitelist.js";
import { SchedulerError } from "./brain-errors.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("scheduler");


const SCHEDULE_FILE = `${BRAIN_DIR}/scheduled-messages.json`;
const IN_FLIGHT_FILE = `${BRAIN_DIR}/scheduled-messages-inflight.json`;
const DELIVERY_LOG_FILE = `${BRAIN_DIR}/delivery-log.json`;
export const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours — must cover scheduler max backoff (2h) + buffer
const DELIVERY_LOG_MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25 hours – must exceed DEDUP_WINDOW_MS (3h), the reflect tick's 12h commitment lookback (ARIA-origin matching), and the prompt's 24h IN-FLIGHT & RECENT DELIVERIES window
const MAX_DELIVERY_LOG_ENTRIES = 500; // hard cap — all outbound sends log here, so bound the file size

export interface ScheduledMessage {
  id: string;
  targetJid: string;
  message: string;
  scheduledAt: number;  // when it was created
  deliverAt: number;    // when to deliver
  source: string;       // "brain" | "chat" | "web"
  retryCount?: number;  // incremented on delivery failure
}

function isValidScheduledMessage(entry: unknown): entry is ScheduledMessage {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.targetJid === "string" &&
    typeof e.message === "string" &&
    typeof e.scheduledAt === "number" &&
    typeof e.deliverAt === "number" &&
    typeof e.source === "string"
  );
}

// Write-through in-memory cache (follows history.ts pattern).
// scheduleCacheMtime tracks the file's mtime at the time we populated the cache,
// so externally appended entries (e.g. ARIA writing directly to the schedule file
// in interactive mode) are detected and reloaded on the next access.
let scheduleCache: ScheduledMessage[] | null = null;
let scheduleCacheMtime: number | null = null;

function scheduleFileMtime(): number {
  try {
    return statSync(SCHEDULE_FILE).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

function loadSchedule(): ScheduledMessage[] {
  const diskMtime = scheduleFileMtime();
  if (scheduleCache && scheduleCacheMtime !== null && diskMtime <= scheduleCacheMtime) {
    return scheduleCache;
  }
  const raw = safeReadJSON<unknown>(SCHEDULE_FILE, []);
  if (!Array.isArray(raw)) {
    log("Schedule file is not a JSON array, starting fresh");
    scheduleCache = [];
    scheduleCacheMtime = diskMtime;
    return scheduleCache;
  }
  const valid: ScheduledMessage[] = [];
  for (const entry of raw) {
    if (isValidScheduledMessage(entry)) {
      valid.push(entry);
    } else {
      log(`Skipping invalid schedule entry: ${JSON.stringify(entry).slice(0, 200)}`);
    }
  }
  if (valid.length < raw.length) {
    log(`Filtered out ${raw.length - valid.length} invalid entry/entries from schedule (${valid.length} valid remaining)`);
  }
  scheduleCache = valid;
  scheduleCacheMtime = diskMtime;
  return scheduleCache;
}

function saveSchedule(messages: ScheduledMessage[]): void {
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(SCHEDULE_FILE, messages);
    scheduleCache = messages;
    // Record the post-write mtime so our own writes don't trigger a reload.
    scheduleCacheMtime = scheduleFileMtime();
  } catch (err) {
    throw new SchedulerError(`Failed to save schedule: ${err}`, {
      cause: err,
      transient: false,
      metadata: { messageCount: messages.length },
    });
  }
}

export function scheduleMessage(
  targetJid: string,
  message: string,
  deliverAt: number,
  source: string = "chat",
): string {
  const id = `sched_${randomUUID()}`;
  // Resolve @lid aliases to canonical phone JIDs at enqueue time so dedup,
  // whitelist checks and the verifier's JID-format check all see the same form.
  const canonicalJid = resolveCanonicalJid(targetJid);
  const entry: ScheduledMessage = {
    id,
    targetJid: canonicalJid,
    message,
    scheduledAt: Date.now(),
    deliverAt,
    source,
  };

  const schedule = loadSchedule();
  schedule.push(entry);
  saveSchedule(schedule);

  const delayMs = deliverAt - Date.now();
  log(`Scheduled message ${id}: "${message.slice(0, 60)}..." for ${new Date(deliverAt).toISOString()} (in ${Math.round(delayMs / 1000)}s)`);
  return id;
}

export function getScheduledMessages(): ScheduledMessage[] {
  return loadSchedule();
}

const MAX_RETRIES = 5;
const BACKOFF_DELAYS_MS = [2 * 60000, 10 * 60000, 30 * 60000, 60 * 60000, 120 * 60000]; // 2m, 10m, 30m, 1h, 2h

/**
 * Check for due messages and return them.
 * Does NOT remove messages from the schedule — caller must use markDelivered()
 * after successful delivery to avoid data loss on send failure.
 */
// ── In-flight claims (cross-process safe) ──
//
// Several processes can poll the same schedule file (the brain loop, a
// recovery worker, an overlapping container during a deploy). A claim is an
// entry in scheduled-messages-inflight.json tagged with this process's
// instance id; the file is only ever rewritten under an exclusive lock file
// and re-read after writing, so two pollers cannot both believe they own the
// same message. Claims by another instance are respected for OTHER_CLAIM_TTL_MS
// (a crashed instance's claims expire after that), our own for IN_FLIGHT_TIMEOUT_MS.

export interface InFlightEntry {
  id: string;
  startedAt: number;
  /** Instance that claimed the message; absent on entries written before instance ids. */
  instanceId?: string;
}

export const INSTANCE_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const IN_FLIGHT_LOCK_FILE = `${IN_FLIGHT_FILE}.lock`;
const IN_FLIGHT_TIMEOUT_MS = 6 * 60 * 1000;   // our own claim: 5min send timeout + 1min buffer
/** A message claimed by another live instance within this window is skipped. */
export const OTHER_CLAIM_TTL_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 10;
const LOCK_RETRY_MS = 20;

// In-memory view of OUR claims (timeout sweep + fast "already claimed" checks).
const inFlightIds = new Map<string, number>();

export interface ClaimReconciliation {
  entries: InFlightEntry[];
  claimed: string[];
  skipped: string[];
}

/**
 * Pure claim policy over the on-disk entries: drop expired claims, keep live
 * claims by other instances (and skip their ids), claim the rest for us.
 */
export function reconcileClaims(
  entries: InFlightEntry[],
  wantedIds: string[],
  instanceId: string,
  now: number,
  ownTtlMs: number = IN_FLIGHT_TIMEOUT_MS,
  otherTtlMs: number = OTHER_CLAIM_TTL_MS,
): ClaimReconciliation {
  const live = entries.filter(e => {
    const ttl = e.instanceId === instanceId ? ownTtlMs : otherTtlMs;
    return now - e.startedAt <= ttl;
  });
  const claimedByOther = new Set(live.filter(e => e.instanceId !== instanceId).map(e => e.id));
  const claimedByUs = new Set(live.filter(e => e.instanceId === instanceId).map(e => e.id));
  const claimed: string[] = [];
  const skipped: string[] = [];
  const added: InFlightEntry[] = [];
  for (const id of wantedIds) {
    if (claimedByOther.has(id)) { skipped.push(id); continue; }
    claimed.push(id);
    if (!claimedByUs.has(id)) added.push({ id, startedAt: now, instanceId });
  }
  return { entries: [...live, ...added], claimed, skipped };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireInFlightLock(): boolean {
  ensureDir(BRAIN_DIR);
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      closeSync(openSync(IN_FLIGHT_LOCK_FILE, "wx"));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        log(`In-flight lock error: ${err}`);
        return false;
      }
      try {
        if (Date.now() - statSync(IN_FLIGHT_LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(IN_FLIGHT_LOCK_FILE);
          log("Removed stale in-flight lock");
          continue;
        }
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code !== "ENOENT") log(`In-flight lock stat error: ${statErr}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  return false;
}

function releaseInFlightLock(): void {
  try {
    unlinkSync(IN_FLIGHT_LOCK_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`Failed to release in-flight lock: ${err}`);
  }
}

function readInFlightFile(): InFlightEntry[] {
  const raw = safeReadJSON<unknown>(IN_FLIGHT_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is InFlightEntry =>
    typeof e === "object" && e !== null
    && typeof (e as InFlightEntry).id === "string"
    && typeof (e as InFlightEntry).startedAt === "number",
  );
}

/** Read-modify-write of the in-flight file under the lock; returns null when the lock could not be taken. */
function updateInFlightFile(update: (entries: InFlightEntry[]) => InFlightEntry[]): InFlightEntry[] | null {
  if (!acquireInFlightLock()) {
    log("Could not acquire in-flight lock — skipping claim update this poll");
    return null;
  }
  try {
    const next = update(readInFlightFile());
    atomicWriteJSON(IN_FLIGHT_FILE, next);
    // Re-read after writing: the rename is atomic, so what is on disk now is what everyone sees.
    return readInFlightFile();
  } catch (err) {
    log(`Warning: failed to update in-flight state: ${err}`);
    return null;
  } finally {
    releaseInFlightLock();
  }
}

/**
 * Claim `ids` for this instance. Returns the ids we verifiably own after the
 * write (re-read from disk), never those claimed by another live instance.
 */
function claimInFlight(ids: string[], now: number): string[] {
  if (ids.length === 0) return [];
  let skipped: string[] = [];
  const onDisk = updateInFlightFile(entries => {
    const r = reconcileClaims(entries, ids, INSTANCE_ID, now);
    skipped = r.skipped;
    return r.entries;
  });
  if (!onDisk) return [];
  if (skipped.length > 0) log(`Skipping ${skipped.length} message(s) claimed by another live instance: ${skipped.join(", ")}`);
  const ours = new Set(onDisk.filter(e => e.instanceId === INSTANCE_ID).map(e => e.id));
  const verified = ids.filter(id => ours.has(id));
  for (const id of verified) inFlightIds.set(id, now);
  return verified;
}

/** Release our claims on `ids` (delivered, failed or blocked). */
function releaseInFlight(ids: string[]): void {
  for (const id of ids) inFlightIds.delete(id);
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  updateInFlightFile(entries => entries.filter(e => !(idSet.has(e.id) && e.instanceId === INSTANCE_ID)));
}

/**
 * On startup, drop expired entries from the in-flight file. Claims by a
 * previous incarnation of this process carry a different instance id, so they
 * are simply "another instance" and expire after OTHER_CLAIM_TTL_MS — a
 * message mid-send during a crash is not retried within that window.
 */
function recoverInFlight(): void {
  if (!existsSync(IN_FLIGHT_FILE)) return;
  const now = Date.now();
  let stale = 0;
  updateInFlightFile(entries => {
    const kept = reconcileClaims(entries, [], INSTANCE_ID, now).entries;
    stale = entries.length - kept.length;
    return kept;
  });
  if (stale > 0) log(`Crash recovery: released ${stale} stale in-flight message(s) for retry`);
}

// Run crash recovery on module load
recoverInFlight();

export function getDueMessages(): ScheduledMessage[] {
  const schedule = loadSchedule();
  const now = Date.now();

  // Sweep stale in-flight IDs so stuck messages can be retried
  const stuck = [...inFlightIds].filter(([, startedAt]) => now - startedAt > IN_FLIGHT_TIMEOUT_MS).map(([id]) => id);
  for (const id of stuck) log(`In-flight timeout: releasing stuck message ${id}`);
  releaseInFlight(stuck);

  const candidates = schedule.filter(m => m.deliverAt <= now && !inFlightIds.has(m.id));
  if (candidates.length === 0) return [];

  // Claim ALL due messages before any other processing (whitelist, etc.) so a
  // concurrent poller — in this process or another — cannot return the same ones.
  const claimedIds = new Set(claimInFlight(candidates.map(m => m.id), now));
  const due = candidates.filter(m => claimedIds.has(m.id));
  if (due.length === 0) return [];

  // Defensive normalization: resolve any @lid aliases on already-queued entries
  // (e.g. messages enqueued before the canonicalization fix landed) so the
  // verifier's strict JID-format check doesn't block them at dispatch.
  const normalized = due.map(m => {
    const canonical = resolveCanonicalJid(m.targetJid);
    return canonical === m.targetJid ? m : { ...m, targetJid: canonical };
  });

  // Single-pass partition into allowed / blocked by whitelist status
  const allowed: ScheduledMessage[] = [];
  const blocked: ScheduledMessage[] = [];
  for (const m of normalized) {
    (isWhitelisted(m.targetJid) ? allowed : blocked).push(m);
  }

  if (blocked.length > 0) {
    log(`Blocked ${blocked.length} scheduled message(s) to non-whitelisted JID(s): ${blocked.map(m => m.targetJid).join(", ")}`);
    // Remove blocked messages from the schedule so they don't accumulate
    const blockedIds = new Set(blocked.map(m => m.id));
    const cleaned = schedule.filter(m => !blockedIds.has(m.id));
    saveSchedule(cleaned);
    // Release blocked messages from in-flight (they've been removed from schedule)
    releaseInFlight(blocked.map(m => m.id));
    // Terminal outcome: record the suppression so the brain prompt shows it
    for (const m of blocked) logDelivery(m.targetJid, m.source, m.message, "suppressed");
  }

  if (allowed.length === 0) {
    if (due.length > 0) log(`All ${due.length} due message(s) were blocked by whitelist`);
    return [];
  }

  log(`${allowed.length} message(s) due for delivery`);
  return allowed;
}

/**
 * Cancel pending scheduled messages for a target/source that have been
 * superseded (e.g. a queued digest made stale by a newer one). Skips
 * messages currently in-flight. Returns the number cancelled.
 */
export function cancelScheduledMessages(targetJid: string, source: string): number {
  const canonicalJid = resolveCanonicalJid(targetJid);
  const schedule = loadSchedule();
  const cancelled = schedule.filter(
    m => m.source === source && resolveCanonicalJid(m.targetJid) === canonicalJid && !inFlightIds.has(m.id),
  );
  if (cancelled.length === 0) return 0;
  const cancelledIds = new Set(cancelled.map(m => m.id));
  saveSchedule(schedule.filter(m => !cancelledIds.has(m.id)));
  for (const m of cancelled) {
    log(`Cancelled superseded scheduled message ${m.id} (source=${source}, was due ${new Date(m.deliverAt).toISOString()}): "${m.message.slice(0, 60)}..."`);
  }
  return cancelled.length;
}

/**
 * Remove successfully delivered messages from the schedule file.
 */
export function markDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const schedule = loadSchedule();
  const idSet = new Set(ids);
  const remaining = schedule.filter(m => !idSet.has(m.id));
  saveSchedule(remaining);
  releaseInFlight(ids);
  log(`Marked ${ids.length} message(s) as delivered, ${remaining.length} remaining`);
}

/**
 * Increment retryCount for failed messages. Removes messages exceeding MAX_RETRIES.
 * Returns IDs of messages that were dropped due to exceeding retry limit.
 */
export function markFailed(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const schedule = loadSchedule();
  const idSet = new Set(ids);
  const droppedMessages: ScheduledMessage[] = [];
  const remaining: ScheduledMessage[] = [];

  for (const msg of schedule) {
    if (!idSet.has(msg.id)) { remaining.push(msg); continue; }
    const retryCount = (msg.retryCount || 0) + 1;
    if (retryCount > MAX_RETRIES) {
      droppedMessages.push(msg);
      continue;
    }
    const baseMs = BACKOFF_DELAYS_MS[retryCount - 1] || BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
    const backoffMs = Math.round(baseMs * (0.75 + Math.random() * 0.5));
    log(`Message ${msg.id} retry ${retryCount}/${MAX_RETRIES}, next attempt in ${Math.round(backoffMs / 60000)}min`);
    remaining.push({ ...msg, retryCount, deliverAt: Date.now() + backoffMs });
  }

  const droppedIds = droppedMessages.map(m => m.id);
  saveSchedule(remaining);
  // Clear in-flight tracking for all failed messages (retried or dropped)
  releaseInFlight(ids);

  if (droppedIds.length > 0) {
    log(`Dropped ${droppedIds.length} message(s) after exceeding ${MAX_RETRIES} retries`);
    // Terminal outcome: record the permanent failure so the brain prompt shows it
    for (const m of droppedMessages) logDelivery(m.targetJid, m.source, m.message, "failed");
  }
  return droppedIds;
}

// ── Delivery Log (for dedup between chat-sourced and brain-sourced messages) ──

export interface DeliveryRecord {
  jid: string;
  source: string;
  timestamp: number;
  messageSnippet: string;
  status?: string; // "sent" — optional for backward compat with pre-status entries
}

// Write-through in-memory cache for delivery log
let deliveryLogCache: DeliveryRecord[] | null = null;

function isDeliveryRecord(entry: unknown): entry is DeliveryRecord {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.jid === "string" &&
    typeof e.source === "string" &&
    typeof e.timestamp === "number" &&
    typeof e.messageSnippet === "string" &&
    (e.status === undefined || typeof e.status === "string")
  );
}

function loadDeliveryLog(): DeliveryRecord[] {
  if (deliveryLogCache) return deliveryLogCache;
  const raw = safeReadJSON<unknown>(DELIVERY_LOG_FILE, []);
  if (Array.isArray(raw)) {
    const valid: DeliveryRecord[] = [];
    for (const entry of raw) {
      if (isDeliveryRecord(entry)) {
        valid.push(entry);
      } else {
        log.warn(`Discarding malformed delivery log entry: ${JSON.stringify(entry)}`);
      }
    }
    if (valid.length < raw.length) {
      log.warn(`Filtered ${raw.length - valid.length} malformed entries from delivery log`);
    }
    deliveryLogCache = valid;
    return deliveryLogCache;
  }
  deliveryLogCache = [];
  return deliveryLogCache;
}

function saveDeliveryLog(entries: DeliveryRecord[]): void {
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(DELIVERY_LOG_FILE, entries);
    deliveryLogCache = entries;
  } catch (err) {
    throw new SchedulerError(`Failed to save delivery log: ${err}`, {
      cause: err,
      transient: false,
      metadata: { entryCount: entries.length },
    });
  }
}

/**
 * Log a delivery outcome for dedup tracking, delivery verification and prompt
 * observability. status "sent" = actually delivered; "suppressed"/"failed" are
 * terminal non-delivery outcomes (visible via getRecentDeliveryLog only).
 */
export function logDelivery(jid: string, source: string, message: string, status: string = "sent"): void {
  const entries = loadDeliveryLog();
  const cutoff = Date.now() - DELIVERY_LOG_MAX_AGE_MS;
  // Prune old entries while adding new one
  let pruned = entries.filter(e => e.timestamp > cutoff);
  pruned.push({ jid, source, timestamp: Date.now(), messageSnippet: message.slice(0, 120), status });
  if (pruned.length > MAX_DELIVERY_LOG_ENTRIES) {
    pruned = pruned.slice(-MAX_DELIVERY_LOG_ENTRIES);
  }
  saveDeliveryLog(pruned);
}

/**
 * Get recent SUCCESSFUL deliveries, optionally filtered by time window.
 * Excludes suppressed/failed outcomes so dedup, commitment matching and
 * delivery verification never mistake a non-delivery for actual contact.
 */
export function getRecentDeliveries(windowMs: number = DELIVERY_LOG_MAX_AGE_MS): DeliveryRecord[] {
  return getRecentDeliveryLog(windowMs).filter(e => e.status === undefined || e.status === "sent");
}

/**
 * Get the raw recent delivery log INCLUDING suppressed/failed terminal
 * outcomes — for the prompt's IN-FLIGHT & RECENT DELIVERIES section.
 */
export function getRecentDeliveryLog(windowMs: number = DELIVERY_LOG_MAX_AGE_MS): DeliveryRecord[] {
  const entries = loadDeliveryLog();
  const cutoff = Date.now() - windowMs;
  return entries.filter(e => e.timestamp > cutoff);
}
