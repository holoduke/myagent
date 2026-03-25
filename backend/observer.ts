import { appendFileSync, readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { ensureDir, atomicWriteFile, safeReadJSON } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BrainError } from "./brain-errors.js";
import { scoreAndMaybeInterrupt } from "./urgency.js";
import { classifyTrust, detectInjection, logInjectionAttempt } from "./trust.js";
import { extractAndClassifyCommitments } from "./commitments.js";
import type { ClassifiedCommitment } from "./commitments.js";
import { detectActionableContent } from "./actionable.js";
import type { ActionableSignal } from "./actionable.js";
import { isWhitelisted } from "./contact-whitelist.js";
import { processObservation as trackActionable } from "./actionable-tracker.js";
import { routeObservationToDirectives } from "./directive-router.js";
import { detectWithPrompt } from "./prompt-detector.js";
import type { PromptDetectionResult } from "./prompt-detector.js";
import { getBrainConfig } from "./brain-config.js";

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
  source?: "whatsapp" | "gmail" | "slack" | "calendar" | "homeassistant" | "rss" | "owntracks" | "twilio" | "browser";
  emailMeta?: EmailMeta;
  calendarMeta?: CalendarMeta;
  locationMeta?: LocationMeta;
  callMeta?: CallMeta;
  slackMeta?: SlackMeta;
  urgency?: number;
  /** Trust classification — set at intake, used for prompt sanitization */
  trustLevel?: "owner" | "trusted" | "untrusted";
  /** Detected commitments in outgoing messages (isFromMe=true only) */
  detectedCommitments?: ClassifiedCommitment[];
  /** Actionable content detected from whitelisted contacts (incoming only) */
  actionableSignals?: ActionableSignal[];
  /** Structured event data from prompt-based detection */
  promptDetectionResult?: PromptDetectionResult;
}

export interface CallMeta {
  callSid: string;
  to: string;
  from: string;
  mode: "simple" | "agent";
  duration?: number;
}

export interface SlackMeta {
  workspaceId: string;
  channelId: string;
  channelName: string;
  userId: string;
  messageTs: string;
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
    ensureDir(BRAIN_DIR);
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
    atomicWriteFile(DEDUP_FILE, JSON.stringify([...recentObservationKeys]));
    log(`Saved dedup set (${recentObservationKeys.size} entries)`);
  } catch (err) {
    log(`Failed to save dedup set: ${err}`);
  }
}

function loadDedupSet(): void {
  const keys = safeReadJSON<unknown>(DEDUP_FILE, null);
  if (!Array.isArray(keys)) return;
  recentObservationKeys.clear();
  // Load only the most recent entries if file has more than max
  const start = Math.max(0, keys.length - MAX_DEDUP_ENTRIES);
  for (let i = start; i < keys.length; i++) {
    if (typeof keys[i] === "string") recentObservationKeys.add(keys[i] as string);
  }
  if (recentObservationKeys.size > 0) {
    log(`Loaded dedup set (${recentObservationKeys.size} entries from disk)`);
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
  if (obs.slackMeta?.messageTs) return `slack:${obs.slackMeta.workspaceId}:${obs.slackMeta.channelId}:${obs.slackMeta.messageTs}`;
  // For WhatsApp/other: hash by sender + timestamp + first 80 chars
  return `${obs.source || "wa"}:${obs.senderJid}:${obs.timestamp}:${obs.text.slice(0, 80)}`;
}

export function recordObservation(obs: Observation): void {
  const key = getObservationKey(obs);
  if (recentObservationKeys.has(key)) return; // deduplicated

  recentObservationKeys.add(key);
  // Prevent unbounded growth of dedup set — keep newest entries
  if (recentObservationKeys.size > MAX_DEDUP_ENTRIES) {
    const keep = [...recentObservationKeys].slice(-MAX_DEDUP_ENTRIES + 100);
    recentObservationKeys.clear();
    for (const e of keep) recentObservationKeys.add(e);
  }

  // Classify trust level at intake
  if (!obs.trustLevel) {
    obs.trustLevel = classifyTrust(obs);
  }

  // Detect injection attempts in untrusted content
  if (obs.trustLevel === "untrusted") {
    const detection = detectInjection(obs.text);
    if (detection.detected) {
      logInjectionAttempt(obs, detection);
    }
  }

  // Scan outgoing messages for commitments
  if (obs.isFromMe && obs.text) {
    const commitments = extractAndClassifyCommitments(obs.text);
    if (commitments.length > 0) {
      obs.detectedCommitments = commitments;
      log(`Detected ${commitments.length} commitment(s) in outgoing ${obs.source || "whatsapp"} message`);
    }
  }

  // Scan incoming messages from whitelisted contacts for actionable content
  if (!obs.isFromMe && obs.text && isWhitelisted(obs.senderJid)) {
    const config = getBrainConfig();
    const mode = config.detectionMode || "hybrid";

    // Regex detection (fast, free)
    const regexSignals = detectActionableContent(obs.text);

    if (mode === "regex" || (mode === "hybrid" && regexSignals.length > 0)) {
      // Use regex results directly
      if (regexSignals.length > 0) {
        obs.actionableSignals = regexSignals;
        log(`Detected ${regexSignals.length} actionable signal(s) from whitelisted ${obs.sender} (regex)`);
        trackActionable(obs);
        routeObservationToDirectives(obs);
      }
    }

    if (mode === "prompt" || (mode === "hybrid" && regexSignals.length === 0)) {
      // Use prompt-based detection (async, costs a haiku call)
      detectWithPrompt(obs.text, obs.sender).then(result => {
        if (result.events.length > 0 || result.requests.length > 0) {
          // Convert prompt results to actionable signals for compatibility
          const promptSignals: ActionableSignal[] = result.events.map(e => ({
            category: "event" as const,
            snippet: `${e.summary}${e.date ? ` (${e.date}${e.time ? ` ${e.time}` : ""})` : ""}`,
            pattern: "prompt-detected",
          }));

          for (const r of result.requests) {
            promptSignals.push({
              category: "request" as const,
              snippet: r.action,
              pattern: "prompt-detected",
            });
          }

          if (promptSignals.length > 0 && !obs.actionableSignals?.length) {
            obs.actionableSignals = promptSignals;
            obs.promptDetectionResult = result;
            log(`Detected ${result.events.length} events, ${result.requests.length} requests from whitelisted ${obs.sender} (prompt)`);
            trackActionable(obs);
            routeObservationToDirectives(obs);
          }
        }
      }).catch(err => {
        log(`Prompt detection error for ${obs.sender}: ${err}`);
      });
    }
  }

  try {
    ensureBrainDir();
    appendFileSync(OBS_FILE, JSON.stringify(obs) + "\n");

    // Score urgency eagerly and trigger an immediate brain tick if critical
    scoreAndMaybeInterrupt(obs);
  } catch (err) {
    throw new BrainError(`Failed to record observation: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { sender: obs.sender, source: obs.source },
    }, err);
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
      } catch (err) {
        log(`Skipping corrupted observation line: ${err}`);
      }
    }
    return results;
  } catch (err) {
    throw new BrainError(`Failed to read observations: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { since },
    }, err);
  }
}

/**
 * Tail-optimised reader: reads chunks from the end of the file, collects
 * matching observations, and stops as soon as it encounters a line older
 * than `since` (since the file is chronologically ordered).
 */
function getObservationsSinceTail(since: number, filter?: ObservationFilter, limit?: number): Observation[] {
  const results: Observation[] = [];

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
      } catch (err) {
        log(`Skipping corrupted observation line (tail): ${err}`);
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
    throw new BrainError(`Failed to count observations: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { since },
    }, err);
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
      } catch (err) {
        log(`Dropping corrupted line during pruning: ${err}`);
        pruned++;
      }
    }
    if (pruned > 0) {
      atomicWriteFile(OBS_FILE, kept.join("\n") + (kept.length ? "\n" : ""));
      log(`Pruned ${pruned} old observations, kept ${kept.length}`);
    }
  } catch (err) {
    throw new BrainError(`Failed to prune observations: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { cutoffDays: days ?? RETENTION_DAYS },
    }, err);
  }
}
