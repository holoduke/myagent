/**
 * Observation-pipeline downtime tracking.
 * Keeps a lightweight rolling record of observe-tick heartbeats, merged into
 * uptime intervals. Gaps between intervals are periods where the system was
 * deaf (outage, redeploy, kill switch) — silence-type initiative signals must
 * not read those as contacts being quiet.
 */

import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";
import { isCircuitOpen } from "./health-monitor.js";

const log = createLogger("downtime");

const HEARTBEAT_FILE = `${BRAIN_DIR}/observe-heartbeat.json`;

/**
 * Fraction of a silence/absence window overlapping downtime above which the
 * signal is an outage artifact: suppress it entirely instead of surfacing it.
 */
export const DOWNTIME_SUPPRESS_FRACTION = 0.5;
/**
 * Fraction above which a silence/absence signal is low-confidence: surface it,
 * but annotated with the downtime overlap and capped at LOW priority.
 */
export const DOWNTIME_LOW_CONFIDENCE_FRACTION = 0.25;

/** Heartbeats closer together than this belong to the same uptime interval. */
const MERGE_GAP_MS = 30 * 60 * 1000;
/** Drop interval history older than this. */
const RETENTION_MS = 120 * 24 * 60 * 60 * 1000;
/** Throttle disk writes — heartbeats arrive every scheduler tick (~10s). */
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;

export interface UptimeInterval {
  start: number;
  end: number;
}

interface HeartbeatStore {
  intervals: UptimeInterval[];
  /** Windows where the process was up but the brain was down (claude_api circuit breaker open). */
  degraded: UptimeInterval[];
}

let store: HeartbeatStore | null = null;
let lastPersist = 0;

function loadStore(): HeartbeatStore {
  if (store) return store;
  store = safeReadJSON<HeartbeatStore>(HEARTBEAT_FILE, { intervals: [], degraded: [] });
  if (!Array.isArray(store.intervals)) store.intervals = [];
  if (!Array.isArray(store.degraded)) store.degraded = [];
  return store;
}

function persist(force = false): void {
  if (!store) return;
  const now = Date.now();
  if (!force && now - lastPersist < PERSIST_INTERVAL_MS) return;
  lastPersist = now;
  try {
    ensureDir(BRAIN_DIR);
    atomicWriteJSON(HEARTBEAT_FILE, store);
  } catch (err) {
    log(`Failed to persist heartbeat store: ${err}`);
  }
}

/**
 * Record that the observation pipeline is alive right now.
 * `seedMs` (e.g. state.lastObserveTick) bootstraps history on the very first
 * heartbeat, so an outage that predates the heartbeat file still shows up as
 * a gap instead of being invisible.
 */
export function recordObserveHeartbeat(now: number = Date.now(), seedMs?: number): void {
  const s = loadStore();

  if (s.intervals.length === 0 && seedMs && seedMs > 0 && seedMs < now - MERGE_GAP_MS) {
    s.intervals.push({ start: seedMs, end: seedMs });
    log(`Seeded heartbeat history from prior activity at ${new Date(seedMs).toISOString()}`);
  }

  const last = s.intervals[s.intervals.length - 1];
  if (last && now - last.end <= MERGE_GAP_MS) {
    if (now > last.end) last.end = now;
  } else {
    if (last && now > last.end) {
      log(`Downtime gap: ${((now - last.end) / 86400000).toFixed(1)}d since last observe tick`);
    }
    s.intervals.push({ start: now, end: now });
    persist(true);
  }

  // Degraded window: the process is up (heartbeat fires) but the brain is
  // down because the claude_api circuit breaker is open. Recording these as
  // deaf periods lets silence detectors treat a jun–aug style API outage the
  // same as a process outage — otherwise contacts look "quiet" while ARIA
  // simply couldn't think.
  if (isCircuitOpen("claude_api")) {
    const lastDeg = s.degraded[s.degraded.length - 1];
    if (lastDeg && now - lastDeg.end <= MERGE_GAP_MS) {
      if (now > lastDeg.end) lastDeg.end = now;
    } else {
      log("Brain degraded: claude_api circuit breaker open — recording degraded window");
      s.degraded.push({ start: now, end: now });
      persist(true);
    }
  }

  const cutoff = now - RETENTION_MS;
  while (s.intervals.length > 1 && s.intervals[0].end < cutoff) {
    s.intervals.shift();
  }
  while (s.degraded.length > 0 && s.degraded[0].end < cutoff) {
    s.degraded.shift();
  }

  persist();
}

/**
 * Downtime periods ending after `sinceMs`: gaps between uptime intervals
 * (process down) plus degraded windows (process up, brain down). Overlapping
 * periods are merged so overlap math doesn't double-count.
 */
export function getDowntimePeriods(sinceMs: number): UptimeInterval[] {
  const s = loadStore();
  const periods: UptimeInterval[] = [];
  for (let i = 1; i < s.intervals.length; i++) {
    const gapStart = s.intervals[i - 1].end;
    const gapEnd = s.intervals[i].start;
    if (gapEnd - gapStart > MERGE_GAP_MS && gapEnd > sinceMs) {
      periods.push({ start: gapStart, end: gapEnd });
    }
  }
  for (const d of s.degraded) {
    if (d.end - d.start > MERGE_GAP_MS && d.end > sinceMs) {
      periods.push({ start: d.start, end: d.end });
    }
  }
  periods.sort((a, b) => a.start - b.start);
  const merged: UptimeInterval[] = [];
  for (const p of periods) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) {
      if (p.end > last.end) last.end = p.end;
    } else {
      merged.push({ start: p.start, end: p.end });
    }
  }
  return merged;
}

/** Milliseconds of system downtime overlapping the window [startMs, endMs]. */
export function downtimeOverlapMs(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  let total = 0;
  for (const p of getDowntimePeriods(startMs)) {
    total += Math.max(0, Math.min(endMs, p.end) - Math.max(startMs, p.start));
  }
  return total;
}

/**
 * End timestamp of the most recent downtime period (process gap or degraded
 * window) longer than `minGapMs`, or 0. Data recorded before this point spans
 * a deaf period and shouldn't feed frequency baselines.
 */
export function lastMajorDowntimeEnd(minGapMs: number): number {
  const periods = getDowntimePeriods(0);
  for (let i = periods.length - 1; i >= 0; i--) {
    if (periods[i].end - periods[i].start > minGapMs) {
      return periods[i].end;
    }
  }
  return 0;
}

/** Force save (for shutdown hooks). */
export function flushDowntimeTracker(): void {
  persist(true);
}
