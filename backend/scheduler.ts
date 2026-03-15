import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";
import { isWhitelisted } from "./contact-whitelist.js";

const log = createLogger("scheduler");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const SCHEDULE_FILE = `${BRAIN_DIR}/scheduled-messages.json`;
const DELIVERY_LOG_FILE = `${BRAIN_DIR}/delivery-log.json`;
const DELIVERY_LOG_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

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

// Write-through in-memory cache (follows history.ts pattern)
let scheduleCache: ScheduledMessage[] | null = null;

function loadSchedule(): ScheduledMessage[] {
  if (scheduleCache) return scheduleCache;
  try {
    if (existsSync(SCHEDULE_FILE)) {
      const raw = JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8"));
      if (!Array.isArray(raw)) {
        log("Schedule file is not a JSON array, starting fresh");
        scheduleCache = [];
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
      return scheduleCache;
    }
  } catch (err) {
    log(`Failed to read schedule, starting fresh: ${err}`);
  }
  scheduleCache = [];
  return scheduleCache;
}

function saveSchedule(messages: ScheduledMessage[]): void {
  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = SCHEDULE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(messages, null, 2));
    renameSync(tmp, SCHEDULE_FILE);
    scheduleCache = messages;
  } catch (err) {
    log(`Failed to save schedule: ${err}`);
  }
}

export function scheduleMessage(
  targetJid: string,
  message: string,
  deliverAt: number,
  source: string = "chat",
): string {
  const id = `sched_${randomUUID()}`;
  const entry: ScheduledMessage = {
    id,
    targetJid,
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

/**
 * Check for due messages and return them.
 * Does NOT remove messages from the schedule — caller must use markDelivered()
 * after successful delivery to avoid data loss on send failure.
 */
// In-flight message IDs with timestamps: prevents duplicate delivery and enables timeout cleanup
const inFlightIds = new Map<string, number>();
const IN_FLIGHT_TIMEOUT_MS = 6 * 60 * 1000; // 5min send timeout + 1min buffer

export function getDueMessages(): ScheduledMessage[] {
  const schedule = loadSchedule();
  const now = Date.now();

  // Sweep stale in-flight IDs so stuck messages can be retried
  for (const [id, startedAt] of inFlightIds) {
    if (now - startedAt > IN_FLIGHT_TIMEOUT_MS) {
      log(`In-flight timeout: releasing stuck message ${id} (in-flight for ${Math.round((now - startedAt) / 1000)}s)`);
      inFlightIds.delete(id);
    }
  }

  const due = schedule.filter(m => m.deliverAt <= now && !inFlightIds.has(m.id));
  if (due.length === 0) return [];

  // Filter out messages targeting non-whitelisted contacts
  const blocked = due.filter(m => !isWhitelisted(m.targetJid));
  if (blocked.length > 0) {
    log(`Blocked ${blocked.length} scheduled message(s) to non-whitelisted JID(s): ${blocked.map(m => m.targetJid).join(", ")}`);
    // Remove blocked messages from the schedule so they don't accumulate
    const blockedIds = new Set(blocked.map(m => m.id));
    const cleaned = schedule.filter(m => !blockedIds.has(m.id));
    saveSchedule(cleaned);
  }

  const allowed = due.filter(m => isWhitelisted(m.targetJid));
  if (allowed.length === 0) return [];

  // Mark as in-flight immediately so no other poll picks them up
  for (const m of allowed) inFlightIds.set(m.id, now);

  log(`${allowed.length} message(s) due for delivery`);
  return allowed;
}

const MAX_RETRIES = 5;
const BACKOFF_DELAYS_MS = [2 * 60000, 10 * 60000, 30 * 60000, 60 * 60000, 120 * 60000]; // 2m, 10m, 30m, 1h, 2h

/**
 * Remove successfully delivered messages from the schedule file.
 */
export function markDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const schedule = loadSchedule();
  const remaining = schedule.filter(m => !ids.includes(m.id));
  saveSchedule(remaining);
  // Clear in-flight tracking
  for (const id of ids) inFlightIds.delete(id);
  log(`Marked ${ids.length} message(s) as delivered, ${remaining.length} remaining`);
}

/**
 * Increment retryCount for failed messages. Removes messages exceeding MAX_RETRIES.
 * Returns IDs of messages that were dropped due to exceeding retry limit.
 */
export function markFailed(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const schedule = loadSchedule();
  const droppedIds: string[] = [];

  for (const msg of schedule) {
    if (ids.includes(msg.id)) {
      msg.retryCount = (msg.retryCount || 0) + 1;
      if (msg.retryCount > MAX_RETRIES) {
        droppedIds.push(msg.id);
      } else {
        const baseMs = BACKOFF_DELAYS_MS[msg.retryCount - 1] || BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
        const backoffMs = Math.round(baseMs * (0.75 + Math.random() * 0.5));
        msg.deliverAt = Date.now() + backoffMs;
        log(`Message ${msg.id} retry ${msg.retryCount}/${MAX_RETRIES}, next attempt in ${Math.round(backoffMs / 60000)}min`);
      }
    }
  }

  const remaining = schedule.filter(m => !droppedIds.includes(m.id));
  saveSchedule(remaining);
  // Clear in-flight tracking for all failed messages (retried or dropped)
  for (const id of ids) inFlightIds.delete(id);

  if (droppedIds.length > 0) {
    log(`Dropped ${droppedIds.length} message(s) after exceeding ${MAX_RETRIES} retries`);
  }
  return droppedIds;
}

// ── Delivery Log (for dedup between chat-sourced and brain-sourced messages) ──

export interface DeliveryRecord {
  jid: string;
  source: string;
  timestamp: number;
  messageSnippet: string;
}

// Write-through in-memory cache for delivery log
let deliveryLogCache: DeliveryRecord[] | null = null;

function loadDeliveryLog(): DeliveryRecord[] {
  if (deliveryLogCache) return deliveryLogCache;
  try {
    if (existsSync(DELIVERY_LOG_FILE)) {
      const raw = JSON.parse(readFileSync(DELIVERY_LOG_FILE, "utf-8"));
      if (Array.isArray(raw)) {
        deliveryLogCache = raw;
        return deliveryLogCache;
      }
    }
  } catch (err) {
    log(`Failed to load delivery log: ${err}`);
  }
  deliveryLogCache = [];
  return deliveryLogCache;
}

function saveDeliveryLog(entries: DeliveryRecord[]): void {
  try {
    if (!existsSync(BRAIN_DIR)) mkdirSync(BRAIN_DIR, { recursive: true });
    const tmp = DELIVERY_LOG_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(entries, null, 2));
    renameSync(tmp, DELIVERY_LOG_FILE);
    deliveryLogCache = entries;
  } catch (err) {
    log(`Failed to save delivery log: ${err}`);
  }
}

/** Log a successful delivery for dedup tracking. */
export function logDelivery(jid: string, source: string, message: string): void {
  const entries = loadDeliveryLog();
  const cutoff = Date.now() - DELIVERY_LOG_MAX_AGE_MS;
  // Prune old entries while adding new one
  const pruned = entries.filter(e => e.timestamp > cutoff);
  pruned.push({ jid, source, timestamp: Date.now(), messageSnippet: message.slice(0, 120) });
  saveDeliveryLog(pruned);
}

/** Get recent deliveries, optionally filtered by time window. */
export function getRecentDeliveries(windowMs: number = DELIVERY_LOG_MAX_AGE_MS): DeliveryRecord[] {
  const entries = loadDeliveryLog();
  const cutoff = Date.now() - windowMs;
  return entries.filter(e => e.timestamp > cutoff);
}
