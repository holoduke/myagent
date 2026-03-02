import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [scheduler] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const SCHEDULE_FILE = `${BRAIN_DIR}/scheduled-messages.json`;

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

function loadSchedule(): ScheduledMessage[] {
  try {
    if (existsSync(SCHEDULE_FILE)) {
      const raw = JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8"));
      if (!Array.isArray(raw)) {
        log("Schedule file is not a JSON array, starting fresh");
        return [];
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
      return valid;
    }
  } catch {
    log("Failed to read schedule, starting fresh");
  }
  return [];
}

function saveSchedule(messages: ScheduledMessage[]): void {
  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = SCHEDULE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(messages, null, 2));
    renameSync(tmp, SCHEDULE_FILE);
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
  const id = `sched_${Math.random().toString(16).slice(2, 10)}`;
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
export function getDueMessages(): ScheduledMessage[] {
  const schedule = loadSchedule();
  const now = Date.now();

  const due = schedule.filter(m => m.deliverAt <= now);
  if (due.length === 0) return [];

  log(`${due.length} message(s) due for delivery`);
  return due;
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
        const backoffMs = BACKOFF_DELAYS_MS[msg.retryCount - 1] || BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1];
        msg.deliverAt = Date.now() + backoffMs;
        log(`Message ${msg.id} retry ${msg.retryCount}/${MAX_RETRIES}, next attempt in ${Math.round(backoffMs / 60000)}min`);
      }
    }
  }

  const remaining = schedule.filter(m => !droppedIds.includes(m.id));
  saveSchedule(remaining);

  if (droppedIds.length > 0) {
    log(`Dropped ${droppedIds.length} message(s) after exceeding ${MAX_RETRIES} retries`);
  }
  return droppedIds;
}
