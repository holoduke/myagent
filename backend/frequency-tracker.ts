/**
 * Contact frequency tracking and anomaly detection.
 * Tracks daily message counts per person, detects unusual silence or spikes.
 * Uses a 30-day rolling baseline with standard deviation analysis.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";
import {
  downtimeOverlapMs,
  lastMajorDowntimeEnd,
  DOWNTIME_SUPPRESS_FRACTION,
  DOWNTIME_LOW_CONFIDENCE_FRACTION,
} from "./downtime-tracker.js";

const log = createLogger("frequency");

const BASELINES_FILE = `${BRAIN_DIR}/frequency-baselines.json`;
const BASELINE_DAYS = 30;
const ANOMALY_THRESHOLD_STDDEV = 2; // >2 standard deviations = anomaly
const MIN_BASELINE_DAYS = 7; // Need at least 7 days of data before detecting anomalies
const STALE_BASELINE_GAP_MS = 72 * 60 * 60 * 1000; // downtime >72h invalidates pre-gap baseline data

// ── Types ──

export interface FrequencyAnomaly {
  contactJid: string;
  contactName: string;
  type: "silence" | "spike";
  currentCount: number;
  baselineMean: number;
  baselineStdDev: number;
  daysSinceLastMessage: number;
  description: string;
  /**
   * True when a meaningful share (≥25%) of the silence window overlaps system
   * downtime — low confidence, cap at LOW priority. Windows that are mostly
   * (≥50%) downtime are suppressed at the source and never reach consumers.
   */
  likelyArtifact?: boolean;
  /** True when the tracked JID is a group chat (@g.us) rather than an individual contact. */
  isGroup?: boolean;
}

interface ContactBaseline {
  /** JID of the contact */
  jid: string;
  /** Display name (last known) */
  name: string;
  /** Daily counts for the last 30 days: { "YYYY-MM-DD": count } */
  dailyCounts: Record<string, number>;
  /** Timestamp of last message from this contact */
  lastMessageAt: number;
}

type BaselineStore = Record<string, ContactBaseline>;

// ── In-memory cache ──

let baselines: BaselineStore | null = null;
let dirty = false;

function loadBaselines(): BaselineStore {
  if (baselines) return baselines;
  baselines = safeReadJSON<BaselineStore>(BASELINES_FILE, {});
  pruneDeadEntries(baselines);
  return baselines;
}

/**
 * Delete whole baseline entries whose last message is older than the entire
 * retention window. These are dead JID keys (e.g. from the Baileys phone-JID →
 * LID migration): every daily count they hold is past the prune cutoff, so
 * they can never produce a valid baseline again — only false silence alarms.
 */
function pruneDeadEntries(store: BaselineStore): void {
  const cutoff = Date.now() - BASELINE_DAYS * 86400000;
  for (const [jid, baseline] of Object.entries(store)) {
    if (baseline.lastMessageAt < cutoff) {
      delete store[jid];
      dirty = true;
      log(`Pruned dead baseline for ${baseline.name || jid} (last message ${new Date(baseline.lastMessageAt).toISOString().slice(0, 10)})`);
    }
  }
}

function saveBaselines(): void {
  if (!baselines || !dirty) return;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(BASELINES_FILE, baselines);
  dirty = false;
}

// Periodic save
const SAVE_INTERVAL = 5 * 60 * 1000;
const _saveTimer = setInterval(() => saveBaselines(), SAVE_INTERVAL);
_saveTimer.unref();

// ── Public API ──

/**
 * Record a message from a contact. Updates daily count and last message timestamp.
 */
export function updateFrequency(senderJid: string, senderName: string, timestamp: number): void {
  const store = loadBaselines();
  const dateStr = new Date(timestamp).toISOString().slice(0, 10);

  if (!store[senderJid]) {
    store[senderJid] = {
      jid: senderJid,
      name: senderName,
      dailyCounts: {},
      lastMessageAt: timestamp,
    };
  }

  const baseline = store[senderJid];
  baseline.name = senderName; // Update name in case it changed
  baseline.lastMessageAt = Math.max(baseline.lastMessageAt, timestamp);
  baseline.dailyCounts[dateStr] = (baseline.dailyCounts[dateStr] || 0) + 1;

  // Prune old entries (keep only BASELINE_DAYS worth)
  const cutoffDate = new Date(Date.now() - BASELINE_DAYS * 86400000).toISOString().slice(0, 10);
  for (const date of Object.keys(baseline.dailyCounts)) {
    if (date < cutoffDate) {
      delete baseline.dailyCounts[date];
    }
  }

  pruneDeadEntries(store);

  dirty = true;
}

/**
 * Detect frequency anomalies across all tracked contacts.
 * Returns contacts with significantly unusual activity levels.
 */
export function detectAnomalies(): FrequencyAnomaly[] {
  const store = loadBaselines();
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  const anomalies: FrequencyAnomaly[] = [];

  // Baselines that span a long system-downtime gap are stale: the zero-count
  // days during the gap reflect ARIA being deaf, not contacts being quiet.
  // Only trust daily counts recorded after the most recent >72h gap.
  const staleCutoff = lastMajorDowntimeEnd(STALE_BASELINE_GAP_MS);

  // Enumerate the days the system was actually listening: the retention window
  // (truncated to the end of the last major outage), minus days that were
  // majority-downtime. dailyCounts only holds days with messages, so zero-fill
  // over these observed days — using active days as the denominator would read
  // as msgs-per-active-day, and counting deaf days would deflate every rate.
  const windowStartMs = Math.max(now - BASELINE_DAYS * 86400000, staleCutoff);
  const firstDayStartMs = Math.floor(windowStartMs / 86400000) * 86400000;
  const observedDates: string[] = [];
  for (let dayStart = firstDayStartMs; dayStart < now; dayStart += 86400000) {
    const dayEnd = Math.min(dayStart + 86400000, now);
    if (downtimeOverlapMs(dayStart, dayEnd) < (dayEnd - dayStart) / 2) {
      observedDates.push(new Date(dayStart).toISOString().slice(0, 10));
    }
  }

  for (const [jid, baseline] of Object.entries(store)) {
    const isGroup = jid.endsWith("@g.us");
    const counts = observedDates.map(d => baseline.dailyCounts[d] || 0);
    const activeDays = counts.filter(c => c > 0).length;
    if (activeDays < MIN_BASELINE_DAYS) continue; // Not enough (fresh) history

    // Mean and stddev of msgs/day over observed (non-downtime) days
    const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
    const variance = counts.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / counts.length;
    const stdDev = Math.sqrt(variance);

    // Only flag contacts with meaningful baseline activity (mean > 0.5 msgs/day)
    if (mean < 0.5) continue;

    const todayCount = baseline.dailyCounts[today] || 0;
    const daysSinceLast = (now - baseline.lastMessageAt) / 86400000;

    // An entry silent for longer than the entire baseline retention window is
    // stale bookkeeping (dead JID), not real silence — the person may well be
    // messaging today under a different JID. Never flag these.
    if (daysSinceLast > BASELINE_DAYS) continue;

    // Detect silence on the EFFECTIVE window: raw silence minus downtime
    // overlap. Time the system was deaf says nothing about the contact.
    const silenceMs = now - baseline.lastMessageAt;
    const downMs = downtimeOverlapMs(baseline.lastMessageAt, now);
    const downFraction = silenceMs > 0 ? downMs / silenceMs : 0;
    const effectiveSilenceDays = Math.max(0, silenceMs - downMs) / 86400000;
    const expectedDaysOfSilence = mean > 0 ? 1 / mean : Infinity; // avg days between messages
    if (effectiveSilenceDays > expectedDaysOfSilence * ANOMALY_THRESHOLD_STDDEV && effectiveSilenceDays > 3) {
      const downDays = Math.round(downMs / 86400000);
      if (downFraction >= DOWNTIME_SUPPRESS_FRACTION) {
        // Mostly deafness, not silence — suppress rather than surface a poisoned signal.
        log(`Suppressed silence anomaly for ${baseline.name}: ${downDays}d of ${Math.floor(daysSinceLast)}d window is system downtime`);
      } else {
        const likelyArtifact = downFraction >= DOWNTIME_LOW_CONFIDENCE_FRACTION;
        anomalies.push({
          contactJid: jid,
          contactName: baseline.name,
          type: "silence",
          currentCount: todayCount,
          baselineMean: mean,
          baselineStdDev: stdDev,
          daysSinceLastMessage: Math.floor(daysSinceLast),
          likelyArtifact,
          isGroup,
          description: `${isGroup ? `The "${baseline.name}" group chat` : baseline.name} has been unusually quiet — no messages in ${Math.floor(daysSinceLast)} days (normally ~${mean.toFixed(1)} msgs/day)${downDays >= 1 ? ` (window overlaps ${downDays}d system downtime — low confidence)` : ""}`,
        });
      }
    }

    // Detect spike: today's count > mean + 2*stdDev
    if (stdDev > 0 && todayCount > mean + ANOMALY_THRESHOLD_STDDEV * stdDev && todayCount >= 5) {
      anomalies.push({
        contactJid: jid,
        contactName: baseline.name,
        type: "spike",
        currentCount: todayCount,
        baselineMean: mean,
        baselineStdDev: stdDev,
        daysSinceLastMessage: Math.floor(daysSinceLast),
        isGroup,
        description: `${isGroup ? `The "${baseline.name}" group chat` : baseline.name} is unusually active today — ${todayCount} messages vs normal ~${mean.toFixed(1)}/day`,
      });
    }
  }

  if (anomalies.length > 0) {
    log(`Detected ${anomalies.length} frequency anomalies`);
  }

  return anomalies;
}

/**
 * Force save (for shutdown hooks).
 */
export function flushFrequencyBaselines(): void {
  saveBaselines();
}
