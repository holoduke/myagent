import {
  appendFileSync, readFileSync, existsSync, openSync, fstatSync, readSync, closeSync,
  writeSync, writeFileSync, renameSync, statSync, unlinkSync,
} from "fs";
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
import type { EvaluationResult } from "./message-evaluator.js";
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
const ENRICHMENT_FILE = `${BRAIN_DIR}/observation-enrichment.jsonl`;
const PRUNE_LOCK_FILE = `${BRAIN_DIR}/observations.prune.lock`;
const RETENTION_DAYS = Number(process.env.BRAIN_OBSERVATION_DAYS ?? 7);
/** A prune lock older than this belongs to a crashed instance and may be cleared. */
const PRUNE_LOCK_STALE_MS = 10 * 60 * 1000;

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
  /** Channel message id (WhatsApp key.id) — stable dedup/reply key when present */
  messageId?: string;
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

/**
 * Compact record appended once the async evaluation of an observation
 * finishes. The observation line itself is already persisted by then, so the
 * evaluation outcome lives in a sidecar log keyed by the observation key.
 */
export interface ObservationEnrichment {
  /** When the enrichment was written */
  t: number;
  /** Observation key (see getObservationKey) */
  key: string;
  /** Observation timestamp */
  ts: number;
  senderJid: string;
  intent: IntentClassification["intent"];
  confidence: number;
  method: IntentClassification["method"];
  /** Number of actionable signals (regex + LLM) */
  signals: number;
  usedLLM: boolean;
  /** Whether the evaluator decided to reply */
  reply: boolean;
}

export function ensureBrainDir(): void {
  if (!existsSync(BRAIN_DIR)) {
    ensureDir(BRAIN_DIR);
    log(`Created brain directory: ${BRAIN_DIR}`);
  }
}

// ── Dedup persistence ──

const DEDUP_FILE = `${BRAIN_DIR}/observer-dedup.json`;
const DEDUP_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Also flush the dedup set after this many inserts — restarts happen several times a day. */
const DEDUP_SAVE_EVERY_INSERTS = 20;
const MAX_DEDUP_ENTRIES = 500;

const recentObservationKeys = new Set<string>();
let insertsSinceSave = 0;

export function saveDedupSet(): void {
  try {
    ensureBrainDir();
    atomicWriteFile(DEDUP_FILE, JSON.stringify([...recentObservationKeys]));
    insertsSinceSave = 0;
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

/**
 * Stable identity of an observation for dedup. Prefers channel-native ids
 * (email Message-ID, calendar event id, Slack ts, WhatsApp message id) and
 * falls back to sender + timestamp + text prefix.
 */
export function getObservationKey(obs: Observation): string {
  if (obs.emailMeta?.messageId) return `email:${obs.emailMeta.messageId}`;
  if (obs.calendarMeta?.eventId) return `cal:${obs.calendarMeta.eventId}`;
  if (obs.slackMeta?.messageTs) return `slack:${obs.slackMeta.workspaceId}:${obs.slackMeta.channelId}:${obs.slackMeta.messageTs}`;
  const source = obs.source || "wa";
  if ((source === "wa" || source === "whatsapp") && obs.messageId) {
    return `wa:${obs.chatJid || obs.senderJid}:${obs.messageId}`;
  }
  return `${source}:${obs.senderJid}:${obs.timestamp}:${obs.text.slice(0, 80)}`;
}

/** Returns false when the key was already seen; otherwise records it. */
function trackObservationKey(key: string): boolean {
  if (recentObservationKeys.has(key)) return false;
  recentObservationKeys.add(key);
  // Prevent unbounded growth of dedup set — keep newest entries
  if (recentObservationKeys.size > MAX_DEDUP_ENTRIES) {
    const keep = [...recentObservationKeys].slice(-MAX_DEDUP_ENTRIES + 100);
    recentObservationKeys.clear();
    for (const e of keep) recentObservationKeys.add(e);
  }
  insertsSinceSave += 1;
  if (insertsSinceSave >= DEDUP_SAVE_EVERY_INSERTS) saveDedupSet();
  return true;
}

// ── Intake enrichment (synchronous, before persistence) ──

function trackContactFrequency(obs: Observation): void {
  // Skip non-person sources — feed items and store events aren't contacts.
  if (obs.isFromMe || !obs.senderJid || obs.source === "calendar" || obs.source === "rss" || obs.source === "playstore") return;
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

/**
 * Cheap, synchronous enrichment that must be on the persisted line: trust
 * level, commitments in outgoing text and the urgency score. Mutates `obs`
 * because integrations read these fields back after recording.
 */
function enrichAtIntake(obs: Observation): void {
  if (obs.text) obs.text = sanitizeImageCaption(obs.text);
  if (!obs.trustLevel) obs.trustLevel = classifyTrust(obs);

  trackContactFrequency(obs);

  // Detect injection attempts in untrusted content (detection logging lives here only)
  if (obs.trustLevel === "untrusted") {
    const detection = detectInjection(obs.text);
    if (detection.detected) logInjectionAttempt(obs, detection);
  }

  // Scan outgoing messages for commitments
  if (obs.isFromMe && obs.text) {
    const commitments = extractAndClassifyCommitments(obs.text);
    if (commitments.length > 0) {
      obs.detectedCommitments = commitments;
      log(`Detected ${commitments.length} commitment(s) in outgoing ${obs.source || "whatsapp"} message`);
    }
  }

  // Score urgency synchronously so the persisted line carries it; also
  // triggers an immediate brain tick for eligible high-urgency messages.
  scoreAndMaybeInterrupt(obs);
}

function persistObservation(obs: Observation): void {
  try {
    ensureBrainDir();
    appendFileSync(OBS_FILE, JSON.stringify(obs) + "\n");
  } catch (err) {
    throw new BrainError(`Failed to record observation: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { sender: obs.sender, source: obs.source },
    }, err);
  }
}

// ── Async evaluation (after persistence) ──

function appendEnrichment(record: ObservationEnrichment): void {
  try {
    ensureBrainDir();
    appendFileSync(ENRICHMENT_FILE, JSON.stringify(record) + "\n");
  } catch (err) {
    log(`Failed to append observation enrichment: ${err}`);
  }
}

function applyActionableSignals(obs: Observation, result: EvaluationResult): void {
  if (obs.actionableSignals?.length) return;
  const allSignals = [...result.regexSignals, ...result.llmSignals];
  if (allSignals.length === 0) return;

  obs.actionableSignals = allSignals;
  if (result.detectedEvents.length > 0 || result.detectedRequests.length > 0) {
    obs.promptDetectionResult = {
      events: result.detectedEvents,
      requests: result.detectedRequests,
    };
  }
  log(`Actionable${result.llmSignals.length === 0 ? " (regex)" : ""}: ${allSignals.length} signal(s) from ${obs.sender}`);
  trackActionable(obs);
}

function handleEvaluation(obs: Observation, key: string, result: EvaluationResult): void {
  obs.intentClassification = result.intent;
  log(`Evaluated ${obs.sender}: ${result.intent.intent} (${result.intent.confidence.toFixed(2)}, ${result.intent.method})${result.usedLLM ? " [LLM]" : ""}`);

  applyActionableSignals(obs, result);

  const willReply = !!(result.reply?.shouldReply && result.reply.reply);
  appendEnrichment({
    t: Date.now(),
    key,
    ts: obs.timestamp,
    senderJid: obs.senderJid,
    intent: result.intent.intent,
    confidence: result.intent.confidence,
    method: result.intent.method,
    signals: result.regexSignals.length + result.llmSignals.length,
    usedLLM: result.usedLLM,
    reply: willReply,
  });

  if (!result.reply) return;
  if (willReply) {
    dispatchReply(obs, result.reply, result.replyDirectiveId || "unknown").catch(err => {
      log(`Reply dispatch error for ${obs.sender}: ${err}`);
    });
  } else {
    log(`Reply skipped for ${obs.sender}: shouldReply=${result.reply.shouldReply}, hasText=${!!result.reply.reply}, reason=${result.reply.reason}`);
  }
}

function startAsyncPipelines(obs: Observation, key: string): void {
  // ── Unified message evaluation (single pipeline for intent + actionable + reply) ──
  // Home Assistant digests are machine summaries, not conversation: no intent/reply evaluation.
  if (!obs.isFromMe && obs.text && obs.source !== "homeassistant") {
    evaluateMessage(obs)
      .then(result => handleEvaluation(obs, key, result))
      .catch(err => {
        // The observation line is already persisted; nothing to flag on it.
        log(`Evaluation error for ${obs.sender}: ${err}`);
      });
  }

  // ── User-defined message handlers (independent pipeline) ──
  runMessageHandlers(obs).catch(err => {
    log(`Message handler error for ${obs.sender} [${obs.source || "whatsapp"}]: ${err}`);
  });
}

/**
 * Record an inbound/outbound observation.
 *
 * Order matters: dedup → synchronous enrichment (trust, frequency, urgency)
 * → append to observations.jsonl → async evaluation/handlers. The persisted
 * line therefore carries the urgency score; evaluation results are appended
 * separately to observation-enrichment.jsonl when they arrive.
 */
export function recordObservation(obs: Observation): void {
  if (obs.text) obs.text = sanitizeImageCaption(obs.text);

  const key = getObservationKey(obs);
  if (!trackObservationKey(key)) return; // deduplicated

  enrichAtIntake(obs);
  persistObservation(obs);
  startAsyncPipelines(obs, key);
}

// ── Reading ──

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
 * Tail-optimised reader: reads chunks from the end of the file and collects
 * matching observations. Stops once an ENTIRE chunk is older than `since`.
 * A single older line is not a stop signal: clock skew and out-of-order
 * appends (two instances, delayed integrations) interleave older lines with
 * newer ones, and stopping on the first one would silently drop the rest.
 */
function getObservationsSinceTail(since: number, filter?: ObservationFilter, limit?: number): Observation[] {
  const results: Observation[] = [];

  for (const chunkLines of readTailChunks(OBS_FILE)) {
    const chunkResults: Observation[] = [];
    let parsed = 0;
    let older = 0;
    for (const line of chunkLines) {
      if (!line.trim()) continue;
      try {
        const obs = JSON.parse(line) as Observation;
        parsed++;
        if (obs.timestamp <= since) {
          older++;
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

    if (parsed > 0 && older === parsed) break;
  }

  // Sort by timestamp to ensure correct order even with clock skew
  results.sort((a, b) => a.timestamp - b.timestamp);

  // Apply limit (return the most recent N if limit is set)
  if (limit !== undefined && results.length > limit) {
    return results.slice(results.length - limit);
  }
  return results;
}

const TS_REGEX = /"timestamp"\s*:\s*(\d+(?:\.\d+)?)/;

function countRecentTail(since: number): number {
  let count = 0;
  for (const chunkLines of readTailChunks(OBS_FILE)) {
    let parsed = 0;
    let older = 0;
    for (const line of chunkLines) {
      if (!line.trim()) continue;
      const m = TS_REGEX.exec(line);
      if (!m) continue;
      parsed++;
      if (Number(m[1]) <= since) { older++; continue; }
      count++;
    }
    if (parsed > 0 && older === parsed) break;
  }
  return count;
}

function countFullScan(since: number): number {
  const raw = readFileSync(OBS_FILE, "utf-8");
  let count = 0;
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf("\n", start);
    if (end === -1) end = raw.length;
    const line = raw.substring(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    const m = TS_REGEX.exec(line);
    if (!m) continue;
    if (Number(m[1]) > since) count++;
  }
  return count;
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
    return isRecent ? countRecentTail(since) : countFullScan(since);
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

// ── Pruning ──

function tryCreatePruneLock(): boolean {
  try {
    const fd = openSync(PRUNE_LOCK_FILE, "wx"); // O_CREAT | O_EXCL — fails if another instance holds it
    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function clearStalePruneLock(): boolean {
  try {
    const st = statSync(PRUNE_LOCK_FILE);
    if (Date.now() - st.mtimeMs < PRUNE_LOCK_STALE_MS) return false;
    unlinkSync(PRUNE_LOCK_FILE);
    log(`Cleared stale prune lock (age ${Math.round((Date.now() - st.mtimeMs) / 1000)}s)`);
    return true;
  } catch {
    return false;
  }
}

function acquirePruneLock(): boolean {
  ensureBrainDir();
  return tryCreatePruneLock() || (clearStalePruneLock() && tryCreatePruneLock());
}

function releasePruneLock(): void {
  try {
    unlinkSync(PRUNE_LOCK_FILE);
  } catch (err) {
    log(`Failed to remove prune lock: ${err}`);
  }
}

function partitionByCutoff(raw: string, cutoff: number): { kept: string[]; pruned: number } {
  const kept: string[] = [];
  let pruned = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obs = JSON.parse(line) as Observation;
      if (obs.timestamp >= cutoff) kept.push(line);
      else pruned++;
    } catch (err) {
      log(`Dropping corrupted line during pruning: ${err}`);
      pruned++;
    }
  }
  return { kept, pruned };
}

/** Bytes appended to `filePath` beyond `fromByte` (empty string if none). */
function readAppendedSince(filePath: string, fromByte: number): string {
  const size = statSync(filePath).size;
  if (size <= fromByte) return "";
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size - fromByte);
    readSync(fd, buf, 0, buf.length, fromByte);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Rewrite the observations file without lines older than `cutoff`. Appends
 * that landed while we were filtering are picked up by re-reading the file
 * tail right before the rename, so a concurrent recordObservation() from
 * this or another instance is not lost.
 */
function rewriteObservations(cutoff: number): { kept: number; pruned: number } {
  const raw = readFileSync(OBS_FILE, "utf-8");
  const snapshotBytes = Buffer.byteLength(raw, "utf-8");
  const { kept, pruned } = partitionByCutoff(raw, cutoff);
  if (pruned === 0) return { kept: kept.length, pruned };

  const tmp = `${OBS_FILE}.prune.tmp`;
  writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""));
  const appended = readAppendedSince(OBS_FILE, snapshotBytes);
  if (appended) {
    appendFileSync(tmp, appended.endsWith("\n") ? appended : appended + "\n");
    log(`Prune: carried over ${appended.split("\n").filter(l => l.trim()).length} observation(s) appended during rewrite`);
  }
  renameSync(tmp, OBS_FILE);
  return { kept: kept.length, pruned };
}

function pruneEnrichmentLog(cutoff: number): void {
  if (!existsSync(ENRICHMENT_FILE)) return;
  const lines = readFileSync(ENRICHMENT_FILE, "utf-8").split("\n").filter(l => l.trim());
  const kept = lines.filter(line => {
    const m = /"ts"\s*:\s*(\d+(?:\.\d+)?)/.exec(line);
    return !m || Number(m[1]) >= cutoff;
  });
  if (kept.length !== lines.length) {
    atomicWriteFile(ENRICHMENT_FILE, kept.join("\n") + (kept.length ? "\n" : ""));
  }
}

/**
 * Drop observations older than the retention window. Safe against a second
 * instance: only one holder of the O_EXCL lock file rewrites; the other
 * skips this round. Returns true when a prune ran (even if nothing was old).
 */
export function pruneObservations(days?: number): boolean {
  const cutoff = Date.now() - (days ?? RETENTION_DAYS) * 86400000;
  if (!existsSync(OBS_FILE)) return false;

  if (!acquirePruneLock()) {
    log("Prune skipped: another instance holds the prune lock");
    return false;
  }

  try {
    const { kept, pruned } = rewriteObservations(cutoff);
    if (pruned > 0) log(`Pruned ${pruned} old observations, kept ${kept}`);
    pruneEnrichmentLog(cutoff);
    return true;
  } catch (err) {
    throw new BrainError(`Failed to prune observations: ${err}`, {
      phase: "observer",
      transient: false,
      metadata: { cutoffDays: days ?? RETENTION_DAYS },
    }, err);
  } finally {
    releasePruneLock();
  }
}
