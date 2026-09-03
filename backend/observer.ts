import { appendFileSync, readFileSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { ensureDir, atomicWriteFile, safeReadJSON } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BrainError } from "./brain-errors.js";
import { scoreAndMaybeInterrupt } from "./urgency.js";
import { classifyTrust, detectInjection, logInjectionAttempt } from "./trust.js";
import { extractAndClassifyCommitments } from "./commitments.js";
import type { ClassifiedCommitment } from "./commitments.js";
import type { ActionableSignal } from "./actionable.js";
import { processObservation as trackActionable } from "./actionable-tracker.js";
import type { PromptDetectionResult } from "./prompt-detector.js";
import type { IntentClassification } from "./intent-classifier.js";
import { evaluateMessage } from "./message-evaluator.js";
import { dispatchReply } from "./reply-agent.js";
import { runMessageHandlers } from "./message-handlers.js";
import { BRAIN_DIR } from "./config.js";
import { updateFrequency } from "./frequency-tracker.js";
import { isVisionRefusal } from "./utils/vision.js";

const log = createLogger("observer");

/**
 * If an image-prefixed observation carries a vision-LLM refusal as its
 * "caption", replace it with a neutral marker. Refusal text masquerading as
 * caption pollutes the observation stream and resembles prompt-injection.
 */
function sanitizeImageCaption(text: string): string {
  if (!text.startsWith("[image]")) return text;
  const caption = text.slice("[image]".length).trim();
  if (caption.length > 0 && isVisionRefusal(caption)) {
    return "[image — caption failed]";
  }
  return text;
}


const OBS_FILE = `${BRAIN_DIR}/observations.jsonl`;
const RETENTION_DAYS = Number(process.env.BRAIN_OBSERVATION_DAYS ?? 7);

// Guard against concurrent append + prune on the observations file.
// When pruneObservations() is active, appends are buffered and flushed after prune completes.
let pruneInProgress = false;
let appendBuffer: string[] = [];

export interface EmailMeta {
  from: string;
  to: string;
  subject: string;
  accountId: string;
  accountEmail: string;
  messageId: string;
  /** Message carried a List-Unsubscribe header — bulk/marketing mail marker */
  hasListUnsubscribe?: boolean;
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
  source?: "whatsapp" | "gmail" | "slack" | "calendar" | "homeassistant" | "rss" | "owntracks" | "twilio" | "browser" | "playstore";
  emailMeta?: EmailMeta;
  calendarMeta?: CalendarMeta;
  locationMeta?: LocationMeta;
  callMeta?: CallMeta;
  slackMeta?: SlackMeta;
  urgency?: number;
  /** Email from a high-signal domain (gov, banking) but with no action/deadline language in the body. */
  routineNotification?: boolean;
  /** Promotional/bulk email (marketing domain, List-Unsubscribe, or promo subject) — urgency is forced to 0. */
  promotionalEmail?: boolean;
  /** Trust classification — set at intake, used for prompt sanitization */
  trustLevel?: "owner" | "trusted" | "untrusted";
  /** Detected commitments in outgoing messages (isFromMe=true only) */
  detectedCommitments?: ClassifiedCommitment[];
  /** Actionable content detected from whitelisted contacts (incoming only) */
  actionableSignals?: ActionableSignal[];
  /** Structured event data from prompt-based detection */
  promptDetectionResult?: PromptDetectionResult;
  /** Intent classification for incoming messages */
  intentClassification?: IntentClassification;
  /** Media type if message contains non-text media (voice, image, document) */
  mediaType?: "voice" | "image" | "document";
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
  // Defense in depth: strip vision-LLM refusal text masquerading as a caption
  // before it lands in the observations file or downstream pipelines.
  if (obs.text) {
    obs.text = sanitizeImageCaption(obs.text);
  }

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

  // Track contact frequency for anomaly detection (Phase 5b)
  // Skip non-person sources — feed items and store events aren't contacts.
  if (!obs.isFromMe && obs.senderJid && obs.source !== "calendar" && obs.source !== "rss" && obs.source !== "playstore") {
    updateFrequency(obs.senderJid, obs.sender, obs.timestamp);
    // Group activity also bumps the group chat's own baseline (keyed on the
    // @g.us JID): a group's "silence" is measured across all participants, so
    // only counting individual sender JIDs leaves group entries falsely quiet.
    const groupJid = obs.isGroup
      ? (obs.chatJid ?? (obs.senderJid.endsWith("@g.us") ? obs.senderJid : undefined))
      : undefined;
    if (groupJid && groupJid !== obs.senderJid) {
      updateFrequency(groupJid, obs.groupName || obs.chatName || groupJid.split("@")[0], obs.timestamp);
    }
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

  // ── Unified message evaluation (single pipeline for intent + actionable + reply) ──
  if (!obs.isFromMe && obs.text) {
    evaluateMessage(obs).then(result => {
      // Enrich observation with intent
      obs.intentClassification = result.intent;
      log(`Evaluated ${obs.sender}: ${result.intent.intent} (${result.intent.confidence.toFixed(2)}, ${result.intent.method})${result.usedLLM ? " [LLM]" : ""}`);

      // Merge actionable signals: regex (already found) + LLM-detected
      const allSignals = [...result.regexSignals, ...result.llmSignals];
      if (allSignals.length > 0 && !obs.actionableSignals?.length) {
        obs.actionableSignals = allSignals;

        // Build prompt detection result from LLM events/requests
        if (result.detectedEvents.length > 0 || result.detectedRequests.length > 0) {
          obs.promptDetectionResult = {
            events: result.detectedEvents,
            requests: result.detectedRequests,
          };
        }

        log(`Actionable: ${allSignals.length} signal(s) from ${obs.sender}`);
        trackActionable(obs);
      } else if (result.regexSignals.length > 0 && !obs.actionableSignals?.length) {
        // Regex-only signals (when LLM wasn't called)
        obs.actionableSignals = result.regexSignals;
        log(`Actionable (regex): ${result.regexSignals.length} signal(s) from ${obs.sender}`);
        trackActionable(obs);
      }

      // Dispatch reply if needed
      if (result.reply) {
        if (result.reply.shouldReply && result.reply.reply) {
          dispatchReply(obs, result.reply, result.replyDirectiveId || "unknown").catch(err => {
            log(`Reply dispatch error for ${obs.sender}: ${err}`);
          });
        } else {
          log(`Reply skipped for ${obs.sender}: shouldReply=${result.reply.shouldReply}, hasText=${!!result.reply.reply}, reason=${result.reply.reason}`);
        }
      }
    }).catch(err => {
      log(`Evaluation error for ${obs.sender}: ${err}`);
      // Flag observation as unevaluated so downstream consumers know intent is missing
      obs.intentClassification = { intent: "noise", confidence: 0, method: "heuristic", reason: `evaluation_failed: ${err}` };
    });
  }

  // ── User-defined message handlers (independent pipeline) ──
  runMessageHandlers(obs).catch(err => {
    log(`Message handler error for ${obs.sender} [${obs.source || "whatsapp"}]: ${err}`);
  });

  try {
    ensureBrainDir();
    const line = JSON.stringify(obs) + "\n";

    if (pruneInProgress) {
      // Buffer appends while prune is rewriting the file
      appendBuffer.push(line);
    } else {
      appendFileSync(OBS_FILE, line);
    }

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

  // Sort by timestamp to ensure correct order even with clock skew
  results.sort((a, b) => a.timestamp - b.timestamp);

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

  // Activate prune lock -- appends will be buffered until prune completes
  pruneInProgress = true;
  appendBuffer = [];

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

    // Flush any observations that arrived during prune
    if (appendBuffer.length > 0) {
      appendFileSync(OBS_FILE, appendBuffer.join(""));
      log(`Flushed ${appendBuffer.length} buffered observation(s) after prune`);
    }
  } catch (err) {
    throw new BrainError(`Failed to prune observations: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { cutoffDays: days ?? RETENTION_DAYS },
    }, err);
  } finally {
    appendBuffer = [];
    pruneInProgress = false;
  }
}
