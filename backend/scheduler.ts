import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { existsSync, statSync } from "fs";
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
// In-flight message IDs with timestamps: prevents duplicate delivery and enables timeout cleanup
const inFlightIds = new Map<string, number>();
const IN_FLIGHT_TIMEOUT_MS = 6 * 60 * 1000; // 5min send timeout + 1min buffer
// Max backoff (2h) + generous buffer for crash recovery staleness check
const CRASH_RECOVERY_STALENESS_MS = BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1] + IN_FLIGHT_TIMEOUT_MS;

interface InFlightEntry { id: string; startedAt: number; }

function saveInFlight(): void {
  try {
    const entries: InFlightEntry[] = [];
    for (const [id, startedAt] of inFlightIds) entries.push({ id, startedAt });
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(IN_FLIGHT_FILE, entries);
  } catch (err) {
    log(`Warning: failed to persist in-flight state: ${err}`);
  }
}

/**
 * On startup, recover in-flight state from disk. Entries older than
 * max-backoff + timeout buffer are considered stale (the process crashed
 * during delivery) and are released so the scheduler can retry them.
 */
function recoverInFlight(): void {
  if (!existsSync(IN_FLIGHT_FILE)) return;
  const raw = safeReadJSON<unknown>(IN_FLIGHT_FILE, []);
  if (!Array.isArray(raw)) return;
  const now = Date.now();
  let recovered = 0;
  let stale = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.startedAt !== "number") continue;
    if (now - e.startedAt > CRASH_RECOVERY_STALENESS_MS) {
      // Too old — release for retry (message is still in schedule file)
      stale++;
    } else {
      // Recent — keep as in-flight (delivery might still be happening in another process? unlikely but safe)
      inFlightIds.set(e.id, e.startedAt);
      recovered++;
    }
  }
  if (stale > 0) log(`Crash recovery: released ${stale} stale in-flight message(s) for retry`);
  if (recovered > 0) log(`Crash recovery: preserved ${recovered} recent in-flight message(s)`);
  // Re-save cleaned state
  saveInFlight();
}

// Run crash recovery on module load
recoverInFlight();

export function getDueMessages(): ScheduledMessage[] {
  const schedule = loadSchedule();
  const now = Date.now();

  // Sweep stale in-flight IDs so stuck messages can be retried
  let swept = false;
  for (const [id, startedAt] of inFlightIds) {
    if (now - startedAt > IN_FLIGHT_TIMEOUT_MS) {
      log(`In-flight timeout: releasing stuck message ${id} (in-flight for ${Math.round((now - startedAt) / 1000)}s)`);
      inFlightIds.delete(id);
      swept = true;
    }
  }
  if (swept) saveInFlight();

  const due = schedule.filter(m => m.deliverAt <= now && !inFlightIds.has(m.id));
  if (due.length === 0) return [];

  // Defensive normalization: resolve any @lid aliases on already-queued entries
  // (e.g. messages enqueued before the canonicalization fix landed) so the
  // verifier's strict JID-format check doesn't block them at dispatch.
  for (const m of due) {
    const canonical = resolveCanonicalJid(m.targetJid);
    if (canonical !== m.targetJid) m.targetJid = canonical;
  }

  // Mark ALL due messages as in-flight immediately to prevent race conditions.
  // This must happen before any other processing (whitelist, etc.) to ensure
  // a concurrent getDueMessages() call cannot return the same messages.
  for (const m of due) inFlightIds.set(m.id, now);
  saveInFlight();

  // Single-pass partition into allowed / blocked by whitelist status
  const allowed: ScheduledMessage[] = [];
  const blocked: ScheduledMessage[] = [];
  for (const m of due) {
    (isWhitelisted(m.targetJid) ? allowed : blocked).push(m);
  }

  if (blocked.length > 0) {
    log(`Blocked ${blocked.length} scheduled message(s) to non-whitelisted JID(s): ${blocked.map(m => m.targetJid).join(", ")}`);
    // Remove blocked messages from the schedule so they don't accumulate
    const blockedIds = new Set(blocked.map(m => m.id));
    const cleaned = schedule.filter(m => !blockedIds.has(m.id));
    saveSchedule(cleaned);
    // Release blocked messages from in-flight (they've been removed from schedule)
    for (const m of blocked) inFlightIds.delete(m.id);
    saveInFlight();
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
  // Clear in-flight tracking
  for (const id of ids) inFlightIds.delete(id);
  saveInFlight();
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
  const droppedIds: string[] = [];
  const droppedMessages: ScheduledMessage[] = [];

  for (const msg of schedule) {
    if (idSet.has(msg.id)) {
      msg.retryCount = (msg.retryCount || 0) + 1;
      if (msg.retryCount > MAX_RETRIES) {
        droppedIds.push(msg.id);
        droppedMessages.push(msg);
      } else {
        const baseMs = BACKOFF_DELAYS_MS[msg.retryCount - 1] || BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
        const backoffMs = Math.round(baseMs * (0.75 + Math.random() * 0.5));
        msg.deliverAt = Date.now() + backoffMs;
        log(`Message ${msg.id} retry ${msg.retryCount}/${MAX_RETRIES}, next attempt in ${Math.round(backoffMs / 60000)}min`);
      }
    }
  }

  const droppedSet = new Set(droppedIds);
  const remaining = schedule.filter(m => !droppedSet.has(m.id));
  saveSchedule(remaining);
  // Clear in-flight tracking for all failed messages (retried or dropped)
  for (const id of ids) inFlightIds.delete(id);
  saveInFlight();

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
