/**
 * Actionable request tracker.
 *
 * Persists actionable requests from whitelisted contacts to disk.
 * Each request has a status based on the contact's permission rules:
 * - auto_executed: acted on silently (e.g. event tracked)
 * - pending_confirmation: waiting for owner approval
 * - approved / rejected: owner decided
 *
 * Follows the scheduler.ts write-through cache pattern.
 */

import { randomUUID } from "crypto";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { getActionMode } from "./contact-whitelist.js";
import { createEvent } from "./integrations/calendar.js";
import { loadAccounts } from "./integrations/gmail.js";
import type { ActionableSignal, ActionableCategory } from "./actionable.js";
import type { Observation } from "./observer.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("actionable-tracker");


const REQUESTS_FILE = `${BRAIN_DIR}/actionable-requests.json`;

export type ActionableRequestStatus =
  | "auto_executed"
  | "pending_confirmation"
  | "approved"
  | "rejected";

export interface ActionableRequest {
  id: string;
  timestamp: number;
  senderJid: string;
  senderName: string;
  chatName?: string;
  isGroup: boolean;
  groupName?: string;
  text: string;
  signals: ActionableSignal[];
  categories: ActionableCategory[];
  status: ActionableRequestStatus;
  resolvedAt?: number;
  /** Calendar event ID when an event was auto-created */
  eventId?: string;
}

// ── Write-through cache ──

let cache: ActionableRequest[] | null = null;

function load(): ActionableRequest[] {
  if (cache) return cache;
  cache = safeReadJSON<ActionableRequest[]>(REQUESTS_FILE, []);
  return cache;
}

function save(requests: ActionableRequest[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(REQUESTS_FILE, requests);
  cache = requests;
}

// ── Core functions ──

/**
 * Process an observation that has actionable signals.
 * Determines status per signal category and creates a tracked request.
 */
export function processObservation(obs: Observation): void {
  if (!obs.actionableSignals || obs.actionableSignals.length === 0) return;

  let hasConfirm = false;
  let _hasAuto = false;
  const keptSignals: ActionableSignal[] = [];

  for (const signal of obs.actionableSignals) {
    const mode = getActionMode(obs.senderJid, signal.category);
    if (mode === "ignore") continue;
    if (mode === "confirm") hasConfirm = true;
    if (mode === "auto") _hasAuto = true;
    keptSignals.push(signal);
  }

  // All signals were ignored
  if (keptSignals.length === 0) return;

  // Most restrictive mode wins
  const status: ActionableRequestStatus = hasConfirm ? "pending_confirmation" : "auto_executed";
  const categories = [...new Set(keptSignals.map(s => s.category))];

  const request: ActionableRequest = {
    id: `areq_${randomUUID().slice(0, 8)}`,
    timestamp: obs.timestamp || Date.now(),
    senderJid: obs.senderJid,
    senderName: obs.sender,
    chatName: obs.chatName,
    isGroup: obs.isGroup,
    groupName: obs.groupName,
    text: obs.text,
    signals: keptSignals,
    categories,
    status,
  };

  const requests = load();
  requests.push(request);
  save(requests);

  log(`Tracked ${status} request from ${obs.sender}: ${categories.join(", ")} — "${obs.text.slice(0, 80)}"`);

  // Fire-and-forget: create calendar event for auto_executed event requests
  if (status === "auto_executed" && categories.includes("event")) {
    executeEventCreation(request, obs).catch(err =>
      log(`Event execution failed for ${request.id}: ${err}`),
    );
  }
}

// ── Calendar event execution ──

/**
 * Parse time from signal snippets. Returns [hours, minutes] or null.
 */
function parseTimeFromSignals(signals: ActionableSignal[]): [number, number] | null {
  for (const s of signals) {
    // Match "om 14:30", "at 14:30", "rond 16:00", "ongeveer 13:00", or bare "16:00"
    const m = s.snippet.match(/(?:(?:om|at|rond|ongeveer|omstreeks)\s+)?(\d{1,2})[.:](\d{2})/i);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }
  return null;
}

/**
 * Compute Dutch public holidays for a given year.
 * Easter-based holidays use the Anonymous Gregorian algorithm.
 */
function computeDutchHolidays(year: number): { key: string; date: Date }[] {
  // Anonymous Gregorian Easter algorithm
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1; // 0-indexed
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(year, month, day);

  const addDays = (base: Date, days: number): Date => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  };

  return [
    { key: "new_years_day", date: new Date(year, 0, 1) },
    { key: "easter_sunday", date: easter },
    { key: "easter_monday", date: addDays(easter, 1) },
    { key: "kings_day", date: new Date(year, 3, 27) },
    { key: "liberation_day", date: new Date(year, 4, 5) },
    { key: "ascension", date: addDays(easter, 39) },
    { key: "whit_sunday", date: addDays(easter, 49) },
    { key: "whit_monday", date: addDays(easter, 50) },
    { key: "christmas_day", date: new Date(year, 11, 25) },
    { key: "boxing_day", date: new Date(year, 11, 26) },
    { key: "new_years_eve", date: new Date(year, 11, 31) },
  ];
}

/**
 * Parse a target date from signal snippets. Returns a Date (date only) or null.
 */
function parseDateFromSignals(signals: ActionableSignal[]): Date | null {
  const now = new Date();

  for (const s of signals) {
    const lower = s.snippet.toLowerCase();

    // Relative dates
    if (/\b(morgen|tomorrow)\b/.test(lower)) {
      const d = new Date(now); d.setDate(d.getDate() + 1); return d;
    }
    if (/\b(overmorgen|day after tomorrow)\b/.test(lower)) {
      const d = new Date(now); d.setDate(d.getDate() + 2); return d;
    }

    // Day names
    const dayMap: Record<string, number> = {
      sunday: 0, zondag: 0, monday: 1, maandag: 1, tuesday: 2, dinsdag: 2,
      wednesday: 3, woensdag: 3, thursday: 4, donderdag: 4, friday: 5, vrijdag: 5,
      saturday: 6, zaterdag: 6,
    };
    for (const [name, dayIdx] of Object.entries(dayMap)) {
      if (lower.includes(name)) {
        const d = new Date(now);
        const diff = ((dayIdx - d.getDay()) + 7) % 7 || 7; // next occurrence
        d.setDate(d.getDate() + diff);
        return d;
      }
    }

    // Relative week references
    if (/\b(volgende week|next week)\b/.test(lower)) {
      const d = new Date(now); d.setDate(d.getDate() + 7); return d;
    }
    if (/\b(komend weekend|this weekend|volgend weekend|next weekend)\b/.test(lower)) {
      const d = new Date(now);
      const daysUntilSat = ((6 - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntilSat);
      return d;
    }

    // Dutch holidays (calculate for current/next year)
    const holidays = computeDutchHolidays(now.getFullYear());
    // If all dates are in the past, also check next year
    const nextYearHolidays = computeDutchHolidays(now.getFullYear() + 1);
    const allHolidays = [...holidays, ...nextYearHolidays];

    const holidayMap: Record<string, string[]> = {
      "eerste paasdag": ["easter_sunday"],
      "1e paasdag": ["easter_sunday"],
      "pasen": ["easter_sunday"],
      "tweede paasdag": ["easter_monday"],
      "2e paasdag": ["easter_monday"],
      "paaszondag": ["easter_sunday"],
      "paasmaandag": ["easter_monday"],
      "koningsdag": ["kings_day"],
      "bevrijdingsdag": ["liberation_day"],
      "hemelvaart": ["ascension"],
      "hemelvaartsdag": ["ascension"],
      "eerste pinksterdag": ["whit_sunday"],
      "1e pinksterdag": ["whit_sunday"],
      "pinksteren": ["whit_sunday"],
      "tweede pinksterdag": ["whit_monday"],
      "2e pinksterdag": ["whit_monday"],
      "kerst": ["christmas_day"],
      "eerste kerstdag": ["christmas_day"],
      "1e kerstdag": ["christmas_day"],
      "tweede kerstdag": ["boxing_day"],
      "2e kerstdag": ["boxing_day"],
      "oud en nieuw": ["new_years_eve"],
      "oudejaarsavond": ["new_years_eve"],
      "nieuwjaar": ["new_years_day"],
      "nieuwjaarsdag": ["new_years_day"],
    };

    for (const [name, keys] of Object.entries(holidayMap)) {
      if (lower.includes(name)) {
        for (const key of keys) {
          const holiday = allHolidays.find(h => h.key === key && h.date >= now);
          if (holiday) return holiday.date;
        }
        // Fallback: return earliest matching even if past
        const fallback = allHolidays.find(h => keys.includes(h.key));
        if (fallback) return fallback.date;
      }
    }

    // Explicit date: "on 15 march", "op 15 maart"
    const monthMap: Record<string, number> = {
      january: 0, januari: 0, february: 1, februari: 1, march: 2, maart: 2,
      april: 3, may: 4, mei: 4, june: 5, juni: 5, july: 6, juli: 6,
      august: 7, augustus: 7, september: 8, october: 9, oktober: 9,
      november: 10, december: 11,
    };
    const dateMatch = lower.match(/\b(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|may|june|july|august|october)\b/);
    if (dateMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = monthMap[dateMatch[2]];
      if (month !== undefined) {
        const d = new Date(now.getFullYear(), month, day);
        if (d < now) d.setFullYear(d.getFullYear() + 1); // next year if past
        return d;
      }
    }
  }

  return null;
}

interface ParsedEvent {
  date: Date;
  hours: number;
  minutes: number;
  summary: string;
}

/**
 * Extract multiple events from a message.
 * Splits on "en" / "and" boundaries when different dates are detected,
 * or falls back to single-event parsing from signal snippets.
 */
function extractMultipleEvents(text: string, signals: ActionableSignal[]): ParsedEvent[] {
  // Try splitting the text on " en " / " and " to find separate event clauses
  const clauses = text.split(/\s+(?:en|and)\s+/i);

  if (clauses.length > 1) {
    const events: ParsedEvent[] = [];
    for (const clause of clauses) {
      const clauseSignals: ActionableSignal[] = [{ category: "event", snippet: clause, pattern: "clause" }];
      const date = parseDateFromSignals(clauseSignals);
      if (date) {
        const time = parseTimeFromSignals(clauseSignals);
        events.push({
          date,
          hours: time ? time[0] : 10,
          minutes: time ? time[1] : 0,
          summary: clause.trim().slice(0, 80),
        });
      }
    }
    if (events.length > 0) return events;
  }

  // Fallback: single event from signals
  const targetDate = parseDateFromSignals(signals);
  if (!targetDate) return [];

  const time = parseTimeFromSignals(signals);
  return [{
    date: targetDate,
    hours: time ? time[0] : 10,
    minutes: time ? time[1] : 0,
    summary: signals[0]?.snippet || text.slice(0, 60),
  }];
}

/**
 * Attempt to create calendar event(s) for an auto_executed event request.
 * Supports multiple events in a single message.
 * Updates the request record with the resulting eventId(s).
 */
async function executeEventCreation(request: ActionableRequest, obs: Observation): Promise<void> {
  // Find the first authenticated calendar account
  const accounts = loadAccounts();
  const account = accounts.find(a => a.tokens?.refresh_token || a.tokens?.access_token);
  if (!account) {
    log(`No authenticated calendar account — skipping event creation for ${request.id}`);
    return;
  }

  // If prompt detection provided structured events, use them directly (more reliable)
  if (obs.promptDetectionResult?.events?.length) {
    const eventIds: string[] = [];
    for (const evt of obs.promptDetectionResult.events) {
      const startDate = new Date(`${evt.date}T${evt.time || "10:00"}:00`);
      // Ensure valid date
      if (isNaN(startDate.getTime())) {
        log(`Invalid date from prompt detection: ${evt.date} ${evt.time} — skipping`);
        continue;
      }
      const endDate = new Date(startDate);
      if (evt.endTime) {
        const [eh, em] = evt.endTime.split(":").map(Number);
        endDate.setHours(eh, em, 0, 0);
      } else {
        endDate.setHours(endDate.getHours() + 1);
      }

      const summary = `${obs.sender}: ${evt.summary}`.slice(0, 120);

      const result = await createEvent(
        account.id,
        summary,
        startDate.toISOString(),
        endDate.toISOString(),
        evt.location || undefined,
      );

      if (result.success && result.eventId) {
        eventIds.push(result.eventId);
        log(`Auto-created calendar event ${result.eventId} for request ${request.id}: ${summary}`);
      } else {
        log(`Calendar event creation failed for ${request.id}: ${result.error}`);
      }
    }

    if (eventIds.length > 0) {
      const requests = load();
      const tracked = requests.find(r => r.id === request.id);
      if (tracked) {
        tracked.eventId = eventIds.join(",");
        save(requests);
      }
    }
    return; // Skip regex-based parsing
  }

  const eventSignals = request.signals.filter(s => s.category === "event");

  // Try to extract multiple events from the full message text
  const events = extractMultipleEvents(obs.text, eventSignals);

  if (events.length === 0) {
    log(`Could not parse any events from signals for ${request.id} — skipping event creation`);
    return;
  }

  const eventIds: string[] = [];

  for (const evt of events) {
    const startDate = new Date(evt.date);
    startDate.setHours(evt.hours, evt.minutes, 0, 0);
    const endDate = new Date(startDate);
    endDate.setHours(endDate.getHours() + 1); // default 1h duration

    const summary = `${obs.sender}: ${evt.summary}`.slice(0, 120);

    const result = await createEvent(
      account.id,
      summary,
      startDate.toISOString(),
      endDate.toISOString(),
    );

    if (result.success && result.eventId) {
      eventIds.push(result.eventId);
      log(`Auto-created calendar event ${result.eventId} for request ${request.id}: ${summary}`);
    } else {
      log(`Calendar event creation failed for ${request.id}: ${result.error}`);
    }
  }

  // Update the request record with the created eventId(s)
  if (eventIds.length > 0) {
    const requests = load();
    const tracked = requests.find(r => r.id === request.id);
    if (tracked) {
      tracked.eventId = eventIds.join(",");
      save(requests);
    }
  }
}

/**
 * Get all tracked requests, optionally filtered by status.
 */
export function getActionableRequests(statusFilter?: ActionableRequestStatus): ActionableRequest[] {
  const all = load();
  if (!statusFilter) return all;
  return all.filter(r => r.status === statusFilter);
}

/**
 * Approve a pending request.
 */
export function approveRequest(id: string): ActionableRequest {
  const requests = load();
  const req = requests.find(r => r.id === id);
  if (!req) throw new Error(`Request ${id} not found`);
  if (req.status !== "pending_confirmation") throw new Error(`Request ${id} is ${req.status}, not pending`);
  req.status = "approved";
  req.resolvedAt = Date.now();
  save(requests);
  log(`Approved request ${id} from ${req.senderName}`);
  return req;
}

/**
 * Reject a pending request.
 */
export function rejectRequest(id: string): ActionableRequest {
  const requests = load();
  const req = requests.find(r => r.id === id);
  if (!req) throw new Error(`Request ${id} not found`);
  if (req.status !== "pending_confirmation") throw new Error(`Request ${id} is ${req.status}, not pending`);
  req.status = "rejected";
  req.resolvedAt = Date.now();
  save(requests);
  log(`Rejected request ${id} from ${req.senderName}`);
  return req;
}

/**
 * Create a pending request from a brain-flagged message.
 * Used by the think tick when the brain judges a message from a
 * non-permissioned contact needs owner attention.
 */
export function createFlaggedRequest(flag: {
  senderName: string;
  senderJid: string;
  text: string;
  reason: string;
  categories: string[];
  isGroup?: boolean;
  groupName?: string;
}): ActionableRequest {
  const request: ActionableRequest = {
    id: `areq_${randomUUID().slice(0, 8)}`,
    timestamp: Date.now(),
    senderJid: flag.senderJid,
    senderName: flag.senderName,
    isGroup: flag.isGroup || false,
    groupName: flag.groupName,
    text: flag.text,
    signals: flag.categories.map(c => ({ category: c as ActionableCategory, snippet: flag.reason, pattern: "brain-flagged" })),
    categories: flag.categories as ActionableCategory[],
    status: "pending_confirmation",
  };

  const requests = load();

  // Deduplicate: skip if same sender + similar text already pending
  const isDupe = requests.some(r =>
    r.status === "pending_confirmation" &&
    r.senderJid === flag.senderJid &&
    r.text === flag.text,
  );
  if (isDupe) {
    log(`Skipped duplicate flagged request from ${flag.senderName}`);
    return request;
  }

  requests.push(request);
  save(requests);
  log(`Brain-flagged request from ${flag.senderName}: "${flag.text.slice(0, 80)}" (${flag.reason})`);
  return request;
}

/**
 * Count pending requests (useful for dashboard badge).
 */
export function getPendingCount(): number {
  return load().filter(r => r.status === "pending_confirmation").length;
}

/**
 * Prune old resolved requests (keep last N days).
 */
export function pruneRequests(daysToKeep = 30): number {
  const cutoff = Date.now() - daysToKeep * 86400000;
  const requests = load();
  const kept = requests.filter(r =>
    r.status === "pending_confirmation" || r.timestamp > cutoff,
  );
  const pruned = requests.length - kept.length;
  if (pruned > 0) {
    save(kept);
    log(`Pruned ${pruned} old actionable requests`);
  }
  return pruned;
}
