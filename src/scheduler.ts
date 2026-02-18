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
}

function loadSchedule(): ScheduledMessage[] {
  try {
    if (existsSync(SCHEDULE_FILE)) {
      return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8"));
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
 * Check for due messages and return them. Removes delivered messages from the schedule.
 */
export function getDueMessages(): ScheduledMessage[] {
  const schedule = loadSchedule();
  const now = Date.now();

  const due = schedule.filter(m => m.deliverAt <= now);
  if (due.length === 0) return [];

  const remaining = schedule.filter(m => m.deliverAt > now);
  saveSchedule(remaining);

  log(`${due.length} message(s) due for delivery`);
  return due;
}
