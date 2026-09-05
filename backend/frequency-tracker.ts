/**
 * Contact frequency tracking and anomaly detection.
 * Tracks daily message counts per person, detects unusual silence or spikes.
 * Uses a 30-day rolling baseline with standard deviation analysis.
 */

import { MergedStore } from "./utils/merged-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";
import { canonicalJid } from "./integrations/jid-alias.js";
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

/** A baseline view with all JID aliases of one contact merged together. */
interface MergedBaseline {
  /** Display name of the most recently active alias */
  name: string;
  isGroup: boolean;
  /** Daily counts summed across aliases */
  dailyCounts: Record<string, number>;
  /** Max across aliases */
  lastMessageAt: number;
  /** Contributing store entries (length 1 = no aliasing) */
  aliases: ContactBaseline[];
}

/**
 * Canonical identity for a baseline key. WhatsApp JIDs resolve aliases
 * (@lid ↔ @s.whatsapp.net, device suffixes) via the contact store;
 * non-WhatsApp keys (gmail:…, slack:…) pass through unchanged.
 */
function canonicalKey(jid: string): string {
  if (!jid.includes("@")) return jid;
  try {
    return canonicalJid(jid);
  } catch {
    return jid;
  }
}

/**
 * Merge baseline entries that belong to the same canonical contact. After the
 * Baileys phone-JID→LID migration one person can hold entries under both
 * aliases: the superseded alias accumulates zero messages and reads as "quiet
 * for N days" while the person is actively messaging under the sibling JID.
 */
function mergeAliasedBaselines(store: BaselineStore): Map<string, MergedBaseline> {
  const merged = new Map<string, MergedBaseline>();
  for (const [jid, baseline] of Object.entries(store)) {
    const key = canonicalKey(jid);
    let m = merged.get(key);
    if (!m) {
      m = { name: baseline.name, isGroup: key.endsWith("@g.us"), dailyCounts: {}, lastMessageAt: 0, aliases: [] };
      merged.set(key, m);
    }
    for (const [date, count] of Object.entries(baseline.dailyCounts)) {
      m.dailyCounts[date] = (m.dailyCounts[date] || 0) + count;
    }
    if (baseline.lastMessageAt >= m.lastMessageAt) {
      m.lastMessageAt = baseline.lastMessageAt;
      m.name = baseline.name;
    }
    m.aliases.push(baseline);
  }
  return merged;
}

// ── In-memory cache ──

const store = new MergedStore<BaselineStore>({
  filePath: BASELINES_FILE,
  defaultValue: () => ({}),
});

let baselines: BaselineStore | null = null;
let dirty = false;

function loadBaselines(): BaselineStore {
  if (baselines) return baselines;
  const loaded = store.get();
  baselines = typeof loaded === "object" && loaded !== null ? loaded : {};
  pruneDeadEntries(baselines);
  return baselines;
}

function mergeBaseline(a: ContactBaseline, b: ContactBaseline): ContactBaseline {
  const newer = b.lastMessageAt >= a.lastMessageAt ? b : a;
  const dates = new Set([...Object.keys(a.dailyCounts), ...Object.keys(b.dailyCounts)]);
  const dailyCounts: Record<string, number> = {};
  for (const date of dates) {
    // Both instances may have counted the same messages: take the max, not the sum.
    dailyCounts[date] = Math.max(a.dailyCounts[date] ?? 0, b.dailyCounts[date] ?? 0);
  }
  return { jid: newer.jid, name: newer.name, dailyCounts, lastMessageAt: Math.max(a.lastMessageAt, b.lastMessageAt) };
}

/**
 * Merge the on-disk store (written by another instance) with the in-memory
 * one. Entries present on one side only are kept; shared entries take the
 * per-day maximum and the latest name/timestamp.
 */
export function mergeBaselineStores(disk: BaselineStore, memory: BaselineStore): BaselineStore {
  const merged: BaselineStore = { ...disk };
  for (const [jid, mem] of Object.entries(memory)) {
    merged[jid] = jid in disk ? mergeBaseline(disk[jid], mem) : mem;
  }
  return merged;
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
  try {
    if (store.changedOnDisk()) log("Baselines changed on disk since load — merging with in-memory counts");
    baselines = store.saveMerged(baselines, mergeBaselineStores);
    dirty = false;
  } catch (err) {
    log(`Failed to save frequency baselines: ${err}`);
  }
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

  // Key on the canonical contact identity so a person whose chats flip between
  // JID aliases (@lid vs @s.whatsapp.net) accumulates one baseline, not two.
  // Pre-existing entries under a superseded alias are merged at read time.
  const key = canonicalKey(senderJid);
  if (!store[key]) {
    store[key] = {
      jid: key,
      name: senderName,
      dailyCounts: {},
      lastMessageAt: timestamp,
    };
  }

  const baseline = store[key];
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
 * Look up the last OBSERVED message timestamp for a person by display name.
 * Matches individual contacts only (group JIDs are skipped), case-insensitive:
 * the baseline name must equal the query or appear in it as a whole word —
 * person graph nodes often hold more than the bare name. Returns the most
 * recent timestamp across matching entries, or null when nothing matches.
 *
 * Unlike graph lastAccessedAt (which tracks think-tick access and goes stale
 * whenever the brain is degraded), lastMessageAt is updated by the observation
 * pipeline, so it reflects whether the person actually messaged.
 */
export function lastMessageAtForName(name: string): number | null {
  const query = name.trim().toLowerCase();
  if (!query) return null;
  const store = loadBaselines();
  // Alias-aware: a name match on a superseded JID alias must not report that
  // alias's frozen timestamp — use the canonical contact's max across aliases.
  const maxByKey = new Map<string, number>();
  for (const [jid, baseline] of Object.entries(store)) {
    const key = canonicalKey(jid);
    maxByKey.set(key, Math.max(maxByKey.get(key) ?? 0, baseline.lastMessageAt));
  }
  let best: number | null = null;
  for (const [jid, baseline] of Object.entries(store)) {
    if (jid.endsWith("@g.us")) continue;
    const bName = (baseline.name || "").trim().toLowerCase();
    if (bName.length < 3) continue; // too short to match reliably
    const escaped = bName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholeWord = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u");
    if (bName !== query && !wholeWord.test(query)) continue;
    const at = maxByKey.get(canonicalKey(jid)) ?? baseline.lastMessageAt;
    if (best === null || at > best) {
      best = at;
    }
  }
  return best;
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

  // Detect on the alias-merged view: a per-JID view reads a superseded alias
  // (zero messages since the chat flipped to the sibling JID) as real silence.
  for (const [jid, baseline] of mergeAliasedBaselines(store)) {
    const isGroup = baseline.isGroup;
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

    // Silence is a per-person property, not a per-JID one. The alias merge
    // above handles JID pairs the contact store links; aliases with no stored
    // pairing (e.g. two LIDs for one person) can still split. Aggregate
    // lastMessageAt across same-name individual entries (same matching logic
    // as lastMessageAtForName) and use the max as the silence basis. Names too
    // short to match reliably (<3 chars) keep the per-contact basis, as do groups.
    let silenceBasisAt = baseline.lastMessageAt;
    if (!isGroup && daysSinceLast > 3 && (baseline.name || "").trim().length >= 3) {
      const aggregatedAt = lastMessageAtForName(baseline.name);
      if (aggregatedAt !== null && aggregatedAt > silenceBasisAt) {
        log(`Stale alias bypassed for ${baseline.name} (${jid}): per-JID silence ${Math.floor(daysSinceLast)}d, but same-name activity ${((now - aggregatedAt) / 3600000).toFixed(0)}h ago`);
        silenceBasisAt = aggregatedAt;
      }
    }
    const silenceBasisDays = (now - silenceBasisAt) / 86400000;

    // Detect silence on the EFFECTIVE window: raw silence minus downtime
    // overlap. Time the system was deaf says nothing about the contact.
    const silenceMs = now - silenceBasisAt;
    const downMs = downtimeOverlapMs(silenceBasisAt, now);
    const downFraction = silenceMs > 0 ? downMs / silenceMs : 0;
    const expectedDaysOfSilence = mean > 0 ? 1 / mean : Infinity; // avg days between messages
    const silenceFires = (basisAt: number): boolean => {
      const effDays = Math.max(0, (now - basisAt) - downtimeOverlapMs(basisAt, now)) / 86400000;
      return effDays > expectedDaysOfSilence * ANOMALY_THRESHOLD_STDDEV && effDays > 3;
    };
    if (silenceFires(silenceBasisAt)) {
      const downDays = Math.round(downMs / 86400000);
      if (downFraction >= DOWNTIME_SUPPRESS_FRACTION) {
        // Mostly deafness, not silence — suppress rather than surface a poisoned signal.
        log(`Suppressed silence anomaly for ${baseline.name}: ${downDays}d of ${Math.floor(silenceBasisDays)}d window is system downtime`);
      } else {
        const likelyArtifact = downFraction >= DOWNTIME_LOW_CONFIDENCE_FRACTION;
        anomalies.push({
          contactJid: jid,
          contactName: baseline.name,
          type: "silence",
          currentCount: todayCount,
          baselineMean: mean,
          baselineStdDev: stdDev,
          daysSinceLastMessage: Math.floor(silenceBasisDays),
          likelyArtifact,
          isGroup,
          description: `${isGroup ? `The "${baseline.name}" group chat` : baseline.name} has been unusually quiet — no messages in ${Math.floor(silenceBasisDays)} days (normally ~${mean.toFixed(1)} msgs/day)${downDays >= 1 ? ` (window overlaps ${downDays}d system downtime — low confidence)` : ""}`,
        });
      }
    } else if (baseline.aliases.length > 1) {
      // Debug visibility: a superseded alias (zero messages on that JID while
      // the sibling alias is active) would have fired on its own — the alias
      // merge is what suppressed the false silence signal.
      for (const alias of baseline.aliases) {
        if (alias.lastMessageAt < baseline.lastMessageAt && silenceFires(alias.lastMessageAt)) {
          log(`Alias merge suppressed silence signal for ${baseline.name} (${alias.jid}): alias quiet ${Math.floor((now - alias.lastMessageAt) / 86400000)}d, sibling alias active ${((now - baseline.lastMessageAt) / 3600000).toFixed(0)}h ago`);
        }
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
