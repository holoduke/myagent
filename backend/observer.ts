import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { createLogger } from "./logger.js";

const log = createLogger("observer");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const OBS_FILE = `${BRAIN_DIR}/observations.jsonl`;
const RETENTION_DAYS = Number(process.env.BRAIN_OBSERVATION_DAYS ?? 7);

export interface EmailMeta {
  from: string;
  to: string;
  subject: string;
  accountId: string;
  accountEmail: string;
  messageId: string;
}

export interface CalendarMeta {
  eventId: string;
  calendarId: string;
  accountEmail: string;
  start: string;
  end: string;
  location?: string;
}

export interface LocationMeta {
  lat: number;
  lon: number;
  accuracy: number;
  battery?: number;
  velocity?: number;
}

export interface Observation {
  timestamp: number;
  sender: string;
  senderJid: string;
  isGroup: boolean;
  groupName?: string;
  isFromMe: boolean;
  text: string;
  chatJid?: string;
  chatName?: string;
  source?: "whatsapp" | "gmail" | "calendar" | "homeassistant" | "rss" | "owntracks" | "twilio" | "browser";
  emailMeta?: EmailMeta;
  calendarMeta?: CalendarMeta;
  locationMeta?: LocationMeta;
  callMeta?: CallMeta;
  urgency?: number;
}

export interface CallMeta {
  callSid: string;
  to: string;
  from: string;
  mode: "simple" | "agent";
  duration?: number;
}

export interface ObservationFilter {
  sender?: string;
  source?: Observation["source"];
  isGroup?: boolean;
  isFromMe?: boolean;
  textContains?: string;
}

export function ensureBrainDir(): void {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
    log(`Created brain directory: ${BRAIN_DIR}`);
  }
}

const DEDUP_FILE = `${BRAIN_DIR}/observer-dedup.json`;
const DEDUP_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const recentObservationKeys = new Set<string>();
const MAX_DEDUP_ENTRIES = 500;

// --- Dedup persistence ---

export function saveDedupSet(): void {
  try {
    ensureBrainDir();
    const data = JSON.stringify([...recentObservationKeys]);
    const tmp = DEDUP_FILE + ".tmp";
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, DEDUP_FILE);
    log(`Saved dedup set (${recentObservationKeys.size} entries)`);
  } catch (err) {
    log(`Failed to save dedup set: ${err}`);
  }
}

function loadDedupSet(): void {
  try {
    if (!existsSync(DEDUP_FILE)) return;
    const raw = readFileSync(DEDUP_FILE, "utf-8");
    const keys: unknown = JSON.parse(raw);
    if (!Array.isArray(keys)) return;
    recentObservationKeys.clear();
    // Load only the most recent entries if file has more than max
    const start = Math.max(0, keys.length - MAX_DEDUP_ENTRIES);
    for (let i = start; i < keys.length; i++) {
      if (typeof keys[i] === "string") recentObservationKeys.add(keys[i] as string);
    }
    log(`Loaded dedup set (${recentObservationKeys.size} entries from disk)`);
  } catch (err) {
    log(`Failed to load dedup set, starting fresh: ${err}`);
  }
}

// Load on module init
loadDedupSet();

// Periodic save
const _dedupSaveTimer = setInterval(saveDedupSet, DEDUP_SAVE_INTERVAL_MS);
_dedupSaveTimer.unref(); // Don't block process exit

// Save on shutdown signals
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`Received ${sig}, saving dedup set before exit`);
    saveDedupSet();
  });
}

function getObservationKey(obs: Observation): string {
  if (obs.emailMeta?.messageId) return `email:${obs.emailMeta.messageId}`;
  if (obs.calendarMeta?.eventId) return `cal:${obs.calendarMeta.eventId}`;
  // For WhatsApp/other: hash by sender + timestamp + first 80 chars
  return `${obs.source || "wa"}:${obs.senderJid}:${obs.timestamp}:${obs.text.slice(0, 80)}`;
}

export function recordObservation(obs: Observation): void {
  try {
    const key = getObservationKey(obs);
    if (recentObservationKeys.has(key)) return; // deduplicated

    recentObservationKeys.add(key);
    // Prevent unbounded growth of dedup set — keep newest entries
    if (recentObservationKeys.size > MAX_DEDUP_ENTRIES) {
      const keep = [...recentObservationKeys].slice(-MAX_DEDUP_ENTRIES + 100);
      recentObservationKeys.clear();
      for (const e of keep) recentObservationKeys.add(e);
    }

    ensureBrainDir();
    appendFileSync(OBS_FILE, JSON.stringify(obs) + "\n");
  } catch (err) {
    log(`Failed to record observation: ${err}`);
  }
}

/** Size of chunks read from the tail of the file (256 KB). */
const TAIL_CHUNK_SIZE = 256 * 1024;
/** Threshold: if 'since' is within this window, use tail-read optimisation. */
const TAIL_READ_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

function matchesFilter(obs: Observation, filter: ObservationFilter): boolean {
  if (filter.sender !== undefined && !obs.sender.toLowerCase().includes(filter.sender.toLowerCase())) return false;
  if (filter.source !== undefined && obs.source !== filter.source) return false;
  if (filter.isGroup !== undefined && obs.isGroup !== filter.isGroup) return false;
  if (filter.isFromMe !== undefined && obs.isFromMe !== filter.isFromMe) return false;
  if (filter.textContains !== undefined && !obs.text.toLowerCase().includes(filter.textContains.toLowerCase())) return false;
  return true;
}

/**
 * Read lines from the tail of a file in reverse-chronological chunks.
 * Yields arrays of lines (oldest-first within each chunk) starting from the end.
 */
function* readTailChunks(filePath: string): Generator<string[]> {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    let remaining = stat.size;
    let leftover = ""; // partial line carried from previous chunk

    while (remaining > 0) {
      const chunkSize = Math.min(TAIL_CHUNK_SIZE, remaining);
      const offset = remaining - chunkSize;
      const buf = Buffer.alloc(chunkSize);
      readSync(fd, buf, 0, chunkSize, offset);
      remaining = offset;

      const text = buf.toString("utf-8") + leftover;
      const lines = text.split("\n");

      // First element may be a partial line if we didn't start at offset 0
      leftover = remaining > 0 ? (lines.shift() ?? "") : "";

      yield lines;
    }

    // If there's a leftover partial line from the very beginning of the file
    if (leftover) yield [leftover];
  } finally {
    closeSync(fd);
  }
}

export function getObservationsSince(since: number, filter?: ObservationFilter, limit?: number): Observation[] {
  try {
    if (!existsSync(OBS_FILE)) return [];

    const isRecent = (Date.now() - since) < TAIL_READ_WINDOW_MS;

    if (isRecent) {
      return getObservationsSinceTail(since, filter, limit);
    }

    // Full-file scan for older queries
    const lines = readFileSync(OBS_FILE, "utf-8").split("\n");
    const results: Observation[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        if (obs.timestamp <= since) continue;
        if (filter && !matchesFilter(obs, filter)) continue;
        results.push(obs);
        if (limit !== undefined && results.length >= limit) break;
      } catch {
        // Skip corrupted lines
      }
    }
    return results;
  } catch (err) {
    log(`Failed to read observations: ${err}`);
    return [];
  }
}

/**
 * Tail-optimised reader: reads chunks from the end of the file, collects
 * matching observations, and stops as soon as it encounters a line older
 * than `since` (since the file is chronologically ordered).
 */
function getObservationsSinceTail(since: number, filter?: ObservationFilter, limit?: number): Observation[] {
  const results: Observation[] = [];
  let done = false;

  for (const chunkLines of readTailChunks(OBS_FILE)) {
    const chunkResults: Observation[] = [];
    let foundOlder = false;
    for (const line of chunkLines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        if (obs.timestamp <= since) {
          foundOlder = true;
          continue;
        }
        if (filter && !matchesFilter(obs, filter)) continue;
        chunkResults.push(obs);
      } catch {
        // Skip corrupted lines
      }
    }

    // Prepend chunk results (since we're reading from the end)
    if (chunkResults.length > 0) {
      results.unshift(...chunkResults);
    }

    // If this chunk contained any line older than `since`, we've read far enough
    if (foundOlder) break;
  }

  // Apply limit (return the most recent N if limit is set)
  if (limit !== undefined && results.length > limit) {
    return results.slice(results.length - limit);
  }
  return results;
}

/**
 * Lightweight count of observations since a timestamp.
 * Extracts only the "timestamp" field via regex, avoiding full JSON.parse
 * and Observation object allocation for each line.
 */
export function getObservationCountSince(since: number): number {
  try {
    if (!existsSync(OBS_FILE)) return 0;

    const isRecent = (Date.now() - since) < TAIL_READ_WINDOW_MS;
    const tsRegex = /"timestamp"\s*:\s*(\d+(?:\.\d+)?)/;

    if (isRecent) {
      let count = 0;
      let done = false;
      for (const chunkLines of readTailChunks(OBS_FILE)) {
        let foundOlder = false;
        for (const line of chunkLines) {
          if (!line.trim()) continue;
          const m = tsRegex.exec(line);
          if (!m) continue;
          const ts = Number(m[1]);
          if (ts <= since) { foundOlder = true; continue; }
          count++;
        }
        if (foundOlder) break;
      }
      return count;
    }

    // Full-file scan for older queries
    const raw = readFileSync(OBS_FILE, "utf-8");
    let count = 0;
    let start = 0;
    while (start < raw.length) {
      let end = raw.indexOf("\n", start);
      if (end === -1) end = raw.length;
      const line = raw.substring(start, end);
      start = end + 1;
      if (!line.trim()) continue;
      const m = tsRegex.exec(line);
      if (!m) continue;
      if (Number(m[1]) > since) count++;
    }
    return count;
  } catch (err) {
    log(`Failed to count observations: ${err}`);
    return 0;
  }
}

export function getObservationCount(since: number): number {
  return getObservationCountSince(since);
}

export function pruneObservations(days?: number): void {
  const cutoff = Date.now() - (days ?? RETENTION_DAYS) * 86400000;
  try {
    if (!existsSync(OBS_FILE)) return;
    const lines = readFileSync(OBS_FILE, "utf-8").split("\n");
    const kept: string[] = [];
    let pruned = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        if (obs.timestamp >= cutoff) {
          kept.push(line);
        } else {
          pruned++;
        }
      } catch {
        // Drop corrupted lines during pruning
        pruned++;
      }
    }
    if (pruned > 0) {
      const tmp = OBS_FILE + ".tmp";
      writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""));
      renameSync(tmp, OBS_FILE);
      log(`Pruned ${pruned} old observations, kept ${kept.length}`);
    }
  } catch (err) {
    log(`Failed to prune observations: ${err}`);
  }
}
