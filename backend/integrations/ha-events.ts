/**
 * Home Assistant inbound events — validation + buffered intake.
 *
 * Home Assistant pushes events to ARIA over HTTP (see ha-webhook.ts). Every
 * accepted event lands in a bounded buffer here; nothing goes to the brain
 * directly. The periodic digest (ha-digest.ts) drains the buffer and turns a
 * whole batch into ONE observation, so a chatty house can never bombard the
 * expensive think loop. Reflexes (ha-reflexes.ts) still react instantly to the
 * few events that need a real-time answer.
 *
 * Storage:
 *   /data/homeassistant/pending-events.json   events waiting for the next digest
 *   /data/homeassistant/events.jsonl          rolling history for the dashboard
 */

import { randomUUID } from "crypto";
import { appendFileSync, existsSync, readFileSync } from "fs";
import { FileStore, ensureDir, atomicWriteFile } from "../utils/file-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("ha-events");

export const HA_DIR = "/data/homeassistant";
const PENDING_FILE = `${HA_DIR}/pending-events.json`;
const HISTORY_FILE = `${HA_DIR}/events.jsonl`;

/** Hard caps — protect disk, memory and the digest prompt from floods. */
export const MAX_PENDING_EVENTS = 300;
export const MAX_EVENTS_PER_WINDOW = 120;
export const FLOOD_WINDOW_MS = 10 * 60 * 1000;
/** Identical device+action within this window is treated as contact bounce. */
export const BOUNCE_WINDOW_MS = 1500;
const MAX_STRING_LEN = 200;
const MAX_NESTED_BYTES = 8 * 1024;
const HISTORY_KEEP_LINES = 2000;
const HISTORY_PRUNE_AT = 4000;

// ── Types ──

export interface HAEvent {
  id: string;
  /** When ARIA received the event (ms). */
  receivedAt: number;
  /** Event time as reported by Home Assistant (ms), falls back to receivedAt. */
  ts: number;
  /** "button_press" | "state_change" | free-form (max 64 chars). */
  type: string;
  device?: string;
  entityId?: string;
  friendlyName?: string;
  /** Button/remote action, e.g. "on", "arrow_left_click". */
  action?: string;
  state?: string;
  previousState?: string;
  attributes?: Record<string, unknown>;
  /** Extra context Home Assistant chose to include (e.g. a forecast). */
  context?: Record<string, unknown>;
}

export interface HAEventRecord extends HAEvent {
  /** Reflex that handled this event in real time, if any. */
  handledBy?: string;
  /** One-line summary of what the reflex did (spoken text, etc.). */
  handledSummary?: string;
}

interface PendingState {
  events: HAEventRecord[];
  droppedSinceDigest: number;
  lastDigestAt: number;
  /** Timestamps of accepted events inside the flood window. */
  windowTimestamps: number[];
}

const pendingStore = new FileStore<PendingState>({
  filePath: PENDING_FILE,
  defaultValue: { events: [], droppedSinceDigest: 0, lastDigestAt: 0, windowTimestamps: [] },
});

// ── Validation ──

export type ParseResult = { ok: true; event: HAEvent } | { ok: false; error: string };

function optionalString(value: unknown, field: string): { value?: string; error?: string } {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") return { error: `${field} must be a string` };
  if (value.length > MAX_STRING_LEN) return { error: `${field} exceeds ${MAX_STRING_LEN} chars` };
  return { value };
}

function optionalObject(value: unknown, field: string): { value?: Record<string, unknown>; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return { error: `${field} must be an object` };
  if (JSON.stringify(value).length > MAX_NESTED_BYTES) return { error: `${field} exceeds ${MAX_NESTED_BYTES} bytes` };
  return { value: value as Record<string, unknown> };
}

/** Normalize an event timestamp: accepts ms, seconds, or ISO string. */
export function parseEventTimestamp(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

/** Validate an untrusted webhook body into a well-formed HAEvent. Never throws. */
export function parseHAEvent(raw: unknown, receivedAt: number = Date.now()): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!type) return { ok: false, error: "type is required" };
  if (type.length > 64 || !/^[a-z0-9_.-]+$/i.test(type)) {
    return { ok: false, error: "type must be 1-64 chars of letters, digits, _ . -" };
  }

  const fields = {
    device: optionalString(body.device, "device"),
    entityId: optionalString(body.entity_id ?? body.entityId, "entity_id"),
    friendlyName: optionalString(body.friendly_name ?? body.friendlyName, "friendly_name"),
    action: optionalString(body.action, "action"),
    state: optionalString(body.state, "state"),
    previousState: optionalString(body.previous_state ?? body.previousState, "previous_state"),
  };
  for (const [name, result] of Object.entries(fields)) {
    if (result.error) return { ok: false, error: `${name}: ${result.error}` };
  }
  const attributes = optionalObject(body.attributes, "attributes");
  if (attributes.error) return { ok: false, error: attributes.error };
  const context = optionalObject(body.context, "context");
  if (context.error) return { ok: false, error: context.error };

  if (!fields.device.value && !fields.entityId.value && !fields.friendlyName.value) {
    return { ok: false, error: "one of device, entity_id or friendly_name is required" };
  }

  return {
    ok: true,
    event: {
      id: `hae_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      receivedAt,
      ts: parseEventTimestamp(body.ts ?? body.timestamp ?? body.time_fired, receivedAt),
      type,
      device: fields.device.value,
      entityId: fields.entityId.value,
      friendlyName: fields.friendlyName.value,
      action: fields.action.value,
      state: fields.state.value,
      previousState: fields.previousState.value,
      attributes: attributes.value,
      context: context.value,
    },
  };
}

/** Human label for an event, used in digests and the dashboard. */
export function describeEvent(event: HAEvent): string {
  const subject = event.friendlyName || event.device || event.entityId || "unknown";
  if (event.type === "button_press" || event.action) {
    return `${subject}: ${event.action || "pressed"}`;
  }
  if (event.state !== undefined) {
    const from = event.previousState ? `${event.previousState} → ` : "";
    return `${subject}: ${from}${event.state}`;
  }
  return `${subject}: ${event.type}`;
}

// ── Buffer ──

export type BufferOutcome = "accepted" | "bounce" | "flood" | "overflow";

/** Pure decision: should this event enter the buffer given the current state? */
export function classifyIntake(
  event: HAEvent,
  state: Pick<PendingState, "events" | "windowTimestamps">,
  now: number = event.receivedAt,
): BufferOutcome {
  const last = state.events[state.events.length - 1];
  if (
    last &&
    now - last.receivedAt <= BOUNCE_WINDOW_MS &&
    last.type === event.type &&
    (last.device ?? last.entityId) === (event.device ?? event.entityId) &&
    last.action === event.action &&
    last.state === event.state
  ) {
    return "bounce";
  }
  const inWindow = state.windowTimestamps.filter(t => now - t < FLOOD_WINDOW_MS);
  if (inWindow.length >= MAX_EVENTS_PER_WINDOW) return "flood";
  if (state.events.length >= MAX_PENDING_EVENTS) return "overflow";
  return "accepted";
}

/**
 * Buffer an event for the next digest. Returns how it was treated. Reflex
 * outcome (if any) travels with the record so the digest can tell the brain
 * what ARIA already did about it.
 */
export function bufferEvent(event: HAEvent, handled?: { by: string; summary: string }): BufferOutcome {
  const state = pendingStore.load();
  const now = event.receivedAt;
  const outcome = classifyIntake(event, state, now);
  const windowTimestamps = state.windowTimestamps.filter(t => now - t < FLOOD_WINDOW_MS);

  if (outcome !== "accepted") {
    pendingStore.save({ ...state, windowTimestamps, droppedSinceDigest: state.droppedSinceDigest + 1 });
    log(`Dropped event (${outcome}): ${describeEvent(event)}`);
    return outcome;
  }

  const record: HAEventRecord = handled
    ? { ...event, handledBy: handled.by, handledSummary: handled.summary }
    : { ...event };
  pendingStore.save({
    ...state,
    events: [...state.events, record],
    windowTimestamps: [...windowTimestamps, now],
  });
  appendHistory(record);
  return outcome;
}

export interface DrainResult {
  events: HAEventRecord[];
  dropped: number;
  lastDigestAt: number;
}

/** Take everything pending (for a digest) and reset the buffer. */
export function drainEvents(now: number = Date.now()): DrainResult {
  const state = pendingStore.load();
  const result = { events: state.events, dropped: state.droppedSinceDigest, lastDigestAt: state.lastDigestAt };
  pendingStore.save({
    events: [],
    droppedSinceDigest: 0,
    lastDigestAt: now,
    windowTimestamps: state.windowTimestamps.filter(t => now - t < FLOOD_WINDOW_MS),
  });
  return result;
}

export function getPendingCount(): number {
  return pendingStore.load().events.length;
}

export function getLastDigestAt(): number {
  return pendingStore.load().lastDigestAt;
}

// ── History (dashboard) ──

function appendHistory(record: HAEventRecord): void {
  try {
    ensureDir(HA_DIR);
    appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n");
    pruneHistoryIfNeeded();
  } catch (err) {
    log(`Failed to append event history: ${err}`);
  }
}

function pruneHistoryIfNeeded(): void {
  const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
  if (lines.length <= HISTORY_PRUNE_AT) return;
  atomicWriteFile(HISTORY_FILE, lines.slice(-HISTORY_KEEP_LINES).join("\n") + "\n");
}

/** Most recent events, newest first. */
export function getRecentEvents(limit = 50): HAEventRecord[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
    const records: HAEventRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(line) as HAEventRecord);
      } catch {
        // skip corrupt line
      }
    }
    return records.reverse();
  } catch (err) {
    log(`Failed to read event history: ${err}`);
    return [];
  }
}

/** Count of events received since local midnight (from history). */
export function countEventsSince(since: number): number {
  return getRecentEvents(HISTORY_KEEP_LINES).filter(e => e.receivedAt >= since).length;
}
