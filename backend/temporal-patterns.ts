/**
 * Temporal Pattern Detector (Research: ProActLLM, CIKM 2025)
 *
 * Detects recurring temporal patterns in user behavior to anticipate needs.
 * Examples: "Every Monday morning the owner asks about the week's schedule"
 *           "Alice messages around 9pm on weekdays"
 *           "Owner checks RSS news after lunch"
 *
 * These patterns inform proactive behavior, allowing ARIA to prepare
 * information before it's explicitly requested.
 */

import type { MemoryGraph } from "./memory/graph.js";
import type { MemoryNode } from "./memory/types.js";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("temporal-patterns");

const PATTERNS_FILE = `${BRAIN_DIR}/temporal-patterns.json`;

// ── Types ──

export interface TemporalEvent {
  dayOfWeek: number; // 0 = Sunday, 6 = Saturday
  hourOfDay: number; // 0-23
  topic: string;
  senderJid?: string;
  timestamp: number;
}

export interface TemporalPattern {
  id: string;
  /** When this pattern occurs */
  dayOfWeek: number; // -1 = any day
  hourRange: [number, number]; // e.g. [8, 10] = between 8am-10am
  /** What typically happens */
  topic: string;
  /** Who is involved */
  participant?: string;
  /** How many times observed */
  occurrences: number;
  /** Confidence: occurrences / possible occurrences */
  confidence: number;
  /** Last time pattern was observed */
  lastSeen: number;
  /** Description for prompt */
  description: string;
}

interface PatternsStore {
  events: TemporalEvent[];
  patterns: TemporalPattern[];
  lastAnalysis: number;
}

// ── State ──

let store: PatternsStore | null = null;

function loadStore(): PatternsStore {
  if (store) return store;
  store = safeReadJSON<PatternsStore>(PATTERNS_FILE, {
    events: [],
    patterns: [],
    lastAnalysis: 0,
  });
  return store;
}

function saveStore(): void {
  if (!store) return;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(PATTERNS_FILE, store);
}

/** Reset state for testing. */
export function resetTemporalPatterns(): void {
  store = null;
}

// ── Event Recording ──

/**
 * Record a temporal event from an observation.
 * Called during think ticks to build the event log.
 */
export function recordTemporalEvent(topic: string, senderJid?: string): void {
  const s = loadStore();
  const now = new Date();

  s.events.push({
    dayOfWeek: now.getDay(),
    hourOfDay: now.getHours(),
    topic: topic.toLowerCase().slice(0, 50),
    senderJid,
    timestamp: Date.now(),
  });

  // Keep bounded (last 500 events)
  if (s.events.length > 500) {
    s.events = s.events.slice(-500);
  }

  saveStore();
}

// ── Pattern Analysis ──

const MIN_OCCURRENCES = 3;
const ANALYSIS_INTERVAL = 24 * 3600_000; // Once per day

/**
 * Analyze recorded events to detect recurring temporal patterns.
 * Only runs once per day to avoid excessive computation.
 */
export function analyzePatterns(): TemporalPattern[] {
  const s = loadStore();
  const now = Date.now();

  // Only analyze once per day
  if (now - s.lastAnalysis < ANALYSIS_INTERVAL) return s.patterns;

  if (s.events.length < 10) return s.patterns;

  // Group events by (dayOfWeek, hourRange, topic)
  const buckets = new Map<string, TemporalEvent[]>();
  for (const event of s.events) {
    // 2-hour buckets
    const hourBucket = Math.floor(event.hourOfDay / 2) * 2;
    const key = `${event.dayOfWeek}:${hourBucket}:${event.topic}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(event);
  }

  // Find patterns meeting minimum occurrence threshold
  const newPatterns: TemporalPattern[] = [];

  for (const [key, events] of buckets) {
    if (events.length < MIN_OCCURRENCES) continue;

    const [dayStr, hourStr, topic] = key.split(":");
    const day = parseInt(dayStr);
    const hourBucket = parseInt(hourStr);

    // Calculate how many weeks of data we have
    const oldestEvent = Math.min(...events.map(e => e.timestamp));
    const weeksOfData = Math.max(1, (now - oldestEvent) / (7 * 24 * 3600_000));

    // Confidence: occurrences / possible occurrences (expected once per week)
    const confidence = Math.min(1, events.length / weeksOfData);

    if (confidence < 0.3) continue;

    const participants = [...new Set(events.map(e => e.senderJid).filter(Boolean))];

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const description = `${topic} typically occurs on ${dayNames[day]} around ${hourBucket}:00-${hourBucket + 2}:00` +
      (participants.length > 0 ? ` (involving ${participants[0]})` : "");

    newPatterns.push({
      id: `tp_${key.replace(/[^a-z0-9]/gi, "_")}`,
      dayOfWeek: day,
      hourRange: [hourBucket, hourBucket + 2],
      topic,
      participant: participants[0],
      occurrences: events.length,
      confidence,
      lastSeen: Math.max(...events.map(e => e.timestamp)),
      description,
    });
  }

  // Also detect "any day" patterns (same hour, any day)
  const hourBuckets = new Map<string, TemporalEvent[]>();
  for (const event of s.events) {
    const hourBucket = Math.floor(event.hourOfDay / 2) * 2;
    const key = `any:${hourBucket}:${event.topic}`;
    if (!hourBuckets.has(key)) hourBuckets.set(key, []);
    hourBuckets.get(key)!.push(event);
  }

  for (const [key, events] of hourBuckets) {
    if (events.length < MIN_OCCURRENCES * 2) continue; // Higher threshold for any-day

    const [, hourStr, topic] = key.split(":");
    const hourBucket = parseInt(hourStr);

    const daysOfData = Math.max(1, (now - Math.min(...events.map(e => e.timestamp))) / (24 * 3600_000));
    const confidence = Math.min(1, events.length / daysOfData);
    if (confidence < 0.4) continue;

    const description = `${topic} typically occurs around ${hourBucket}:00-${hourBucket + 2}:00 (daily pattern)`;

    newPatterns.push({
      id: `tp_daily_${key.replace(/[^a-z0-9]/gi, "_")}`,
      dayOfWeek: -1,
      hourRange: [hourBucket, hourBucket + 2],
      topic,
      occurrences: events.length,
      confidence,
      lastSeen: Math.max(...events.map(e => e.timestamp)),
      description,
    });
  }

  // Sort by confidence, keep top 10
  newPatterns.sort((a, b) => b.confidence - a.confidence);
  s.patterns = newPatterns.slice(0, 10);
  s.lastAnalysis = now;
  saveStore();

  if (s.patterns.length > 0) {
    log(`Detected ${s.patterns.length} temporal patterns from ${s.events.length} events`);
  }

  return s.patterns;
}

/**
 * Get patterns that match the current time.
 * Used to inform proactive behavior.
 */
export function getActivePatterns(): TemporalPattern[] {
  const s = loadStore();
  const now = new Date();
  const dayOfWeek = now.getDay();
  const hourOfDay = now.getHours();

  return s.patterns.filter(p =>
    (p.dayOfWeek === -1 || p.dayOfWeek === dayOfWeek) &&
    hourOfDay >= p.hourRange[0] && hourOfDay < p.hourRange[1],
  );
}

/**
 * Generate temporal pattern summary for the brain prompt.
 */
export function getTemporalPatternSummary(): string {
  const active = getActivePatterns();
  if (active.length === 0) return "";

  return active
    .map(p => `- ${p.description} (confidence: ${(p.confidence * 100).toFixed(0)}%)`)
    .join("\n");
}
