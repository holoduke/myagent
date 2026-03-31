/**
 * Contact frequency tracking and anomaly detection.
 * Tracks daily message counts per person, detects unusual silence or spikes.
 * Uses a 30-day rolling baseline with standard deviation analysis.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("frequency");

const BASELINES_FILE = `${BRAIN_DIR}/frequency-baselines.json`;
const BASELINE_DAYS = 30;
const ANOMALY_THRESHOLD_STDDEV = 2; // >2 standard deviations = anomaly
const MIN_BASELINE_DAYS = 7; // Need at least 7 days of data before detecting anomalies

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
  return baselines;
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

  for (const [jid, baseline] of Object.entries(store)) {
    const dates = Object.keys(baseline.dailyCounts).sort();
    if (dates.length < MIN_BASELINE_DAYS) continue; // Not enough history

    // Calculate mean and stddev of daily counts
    const counts = dates.map(d => baseline.dailyCounts[d]);
    const mean = counts.reduce((s, c) => s + c, 0) / counts.length;
    const variance = counts.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / counts.length;
    const stdDev = Math.sqrt(variance);

    // Only flag contacts with meaningful baseline activity (mean > 0.5 msgs/day)
    if (mean < 0.5) continue;

    const todayCount = baseline.dailyCounts[today] || 0;
    const daysSinceLast = (now - baseline.lastMessageAt) / 86400000;

    // Detect silence: no messages for > mean + 2*stdDev days of expected activity
    const expectedDaysOfSilence = mean > 0 ? 1 / mean : Infinity; // avg days between messages
    if (daysSinceLast > expectedDaysOfSilence * ANOMALY_THRESHOLD_STDDEV && daysSinceLast > 3) {
      anomalies.push({
        contactJid: jid,
        contactName: baseline.name,
        type: "silence",
        currentCount: todayCount,
        baselineMean: mean,
        baselineStdDev: stdDev,
        daysSinceLastMessage: Math.floor(daysSinceLast),
        description: `${baseline.name} has been unusually quiet — no messages in ${Math.floor(daysSinceLast)} days (normally ~${mean.toFixed(1)} msgs/day)`,
      });
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
        description: `${baseline.name} is unusually active today — ${todayCount} messages vs normal ~${mean.toFixed(1)}/day`,
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
