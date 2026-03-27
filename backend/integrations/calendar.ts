import { google } from "googleapis";
import { FileStore } from "../utils/file-store.js";
import { recordObservation } from "../observer.js";
import { loadAccounts, createOAuth2Client } from "./gmail.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { createLogger } from "../logger.js";

const log = createLogger("calendar");

const CALENDAR_DIR = "/data/calendar";
const STATE_FILE = `${CALENDAR_DIR}/state.json`;
const CONFIG_FILE = `${CALENDAR_DIR}/config.json`;
const POLL_INTERVAL = Number(process.env.CALENDAR_POLL_INTERVAL ?? 300000);
const ENABLED = process.env.CALENDAR_ENABLED !== "false";

interface CalendarState {
  [accountId: string]: {
    lastSyncTime: number;
  };
}

export interface CalendarConfigEntry {
  id: string;
  name: string;
  tag: "private" | "work" | null;
}

export interface CalendarConfig {
  calendars: CalendarConfigEntry[];
}

const stateStore = new FileStore<CalendarState>({ filePath: STATE_FILE, defaultValue: {} });
const configStore = new FileStore<CalendarConfig>({ filePath: CONFIG_FILE, defaultValue: { calendars: [] } });

function loadState(): CalendarState {
  return stateStore.load();
}

function saveState(state: CalendarState): void {
  stateStore.save(state);
}

async function fetchUpcomingEvents(accountId: string): Promise<void> {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account || (!account.tokens?.refresh_token && !account.tokens?.access_token)) return;

  const auth = createOAuth2Client(account);
  const calendar = google.calendar({ version: "v3", auth });

  try {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: tomorrow.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });

    const events = res.data.items || [];
    let newCount = 0;
    for (const event of events) {
      if (!event.id || !event.summary) continue;

      const start = event.start?.dateTime || event.start?.date || "";
      const end = event.end?.dateTime || event.end?.date || "";
      const location = event.location || "";

      // Dedup key: eventId + start time + updated timestamp (catches reschedules/edits)
      const dedupKey = `${event.id}:${start}:${event.updated || ""}`;
      if (!trackEventKey(dedupKey)) continue;
      newCount++;

      const startDisplay = start ? new Date(start).toLocaleString() : "unknown";
      const endDisplay = end ? new Date(end).toLocaleString() : "unknown";
      const locationPart = location ? ` (${location})` : "";

      recordObservation({
        timestamp: Date.now(),
        sender: "Google Calendar",
        senderJid: `calendar:${accountId}`,
        isGroup: false,
        isFromMe: false,
        text: `[CALENDAR] ${event.summary} — ${startDisplay} to ${endDisplay}${locationPart}`,
        source: "calendar",
        calendarMeta: {
          eventId: event.id,
          calendarId: "primary",
          accountEmail: account.email,
          start,
          end,
          location: location || undefined,
        },
      });
    }

    if (newCount > 0) saveSeenEvents();
    log(`Fetched ${events.length} upcoming events for ${accountId} (${newCount} new)`);
  } catch (err: any) {
    if (err.code === 401) {
      log(`Calendar auth expired for ${accountId}`);
    } else {
      log(`Calendar poll failed for ${accountId}: ${err.message || err}`);
    }
  }
}

// ── Calendar config management ──

export function loadCalendarConfig(): CalendarConfig {
  return configStore.load();
}

export function saveCalendarConfig(config: CalendarConfig): void {
  configStore.save(config);
}

export function getCalendarByTag(tag: string): CalendarConfigEntry | undefined {
  const config = loadCalendarConfig();
  return config.calendars.find(c => c.tag === tag);
}

export async function listCalendars(accountId: string): Promise<Array<{ id: string; name: string }>> {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account || (!account.tokens?.refresh_token && !account.tokens?.access_token)) {
    return [];
  }

  const auth = createOAuth2Client(account);
  const calendar = google.calendar({ version: "v3", auth });

  try {
    const res = await calendar.calendarList.list();
    const items = res.data.items || [];
    return items
      .filter(item => item.id && item.summary)
      .map(item => ({ id: item.id!, name: item.summary! }));
  } catch (err: any) {
    log(`Failed to list calendars for ${accountId}: ${err.message || err}`);
    return [];
  }
}

// ── Seen event dedup (prevents re-emitting same events every poll) ──

const SEEN_EVENTS_FILE = `${CALENDAR_DIR}/seen-events.json`;
const MAX_SEEN_EVENTS = 500;
const seenEventKeys = new Set<string>();

function loadSeenEvents(): void {
  try {
    const data = new FileStore<string[]>({ filePath: SEEN_EVENTS_FILE, defaultValue: [] }).load();
    seenEventKeys.clear();
    for (const key of data) seenEventKeys.add(key);
    if (data.length > 0) log(`Loaded ${seenEventKeys.size} seen event keys from disk`);
  } catch { /* first run — no file yet */ }
}

function saveSeenEvents(): void {
  const allKeys = Array.from(seenEventKeys);
  new FileStore<string[]>({ filePath: SEEN_EVENTS_FILE, defaultValue: [] }).save(allKeys);
}

function trackEventKey(key: string): boolean {
  if (seenEventKeys.has(key)) return false;
  seenEventKeys.add(key);
  // Evict oldest entries if set grows too large
  if (seenEventKeys.size > MAX_SEEN_EVENTS) {
    const iter = seenEventKeys.values();
    const excess = seenEventKeys.size - MAX_SEEN_EVENTS;
    for (let i = 0; i < excess; i++) {
      const val = iter.next().value;
      if (val) seenEventKeys.delete(val);
    }
  }
  return true;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startCalendarPolling(): void {
  if (!ENABLED) {
    log("Calendar polling disabled (CALENDAR_ENABLED=false)");
    return;
  }

  const accounts = loadAccounts();
  const authenticated = accounts.filter(a => a.tokens?.refresh_token || a.tokens?.access_token);

  if (authenticated.length === 0) {
    log("No authenticated accounts for calendar, polling not started");
    return;
  }

  log(`Starting calendar polling for ${authenticated.length} account(s) (every ${POLL_INTERVAL / 1000}s)`);

  loadSeenEvents();
  setTimeout(() => pollAll(), 10000);
  pollTimer = setInterval(() => pollAll(), POLL_INTERVAL);
}

export function stopCalendarPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Calendar polling stopped");
  }
}

async function pollAll(): Promise<void> {
  if (!isIntegrationEnabled("calendar")) return;
  const accounts = loadAccounts();
  const state = loadState();

  for (const account of accounts) {
    if (!account.tokens?.refresh_token && !account.tokens?.access_token) continue;
    try {
      await fetchUpcomingEvents(account.id);
      state[account.id] = { lastSyncTime: Date.now() };
    } catch (err) {
      log(`Calendar poll error for ${account.id}: ${err}`);
    }
  }

  saveState(state);
}

export async function createEvent(
  accountId: string,
  summary: string,
  startDateTime: string,
  endDateTime: string,
  location?: string,
  calendarId?: string,
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account || (!account.tokens?.refresh_token && !account.tokens?.access_token)) {
    return { success: false, error: "Account not found or not authenticated" };
  }

  // Resolve calendar ID: explicit > tag "private" > "primary"
  let targetCalendarId = calendarId;
  if (!targetCalendarId) {
    const privateCalendar = getCalendarByTag("private");
    targetCalendarId = privateCalendar?.id || "primary";
  }

  const auth = createOAuth2Client(account);
  const calendar = google.calendar({ version: "v3", auth });

  try {
    const res = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary,
        start: { dateTime: startDateTime },
        end: { dateTime: endDateTime },
        location,
      },
    });
    log(`Created calendar event: ${summary} (${res.data.id})`);
    return { success: true, eventId: res.data.id || undefined };
  } catch (err: any) {
    log(`Failed to create calendar event: ${err.message || err}`);
    return { success: false, error: err.message || String(err) };
  }
}

export function getCalendarStatus(): { enabled: boolean; accounts: Array<{ id: string; email: string; lastSync: number }>; nextEventCount: number } {
  const accounts = loadAccounts();
  const state = loadState();
  const authenticated = accounts.filter(a => a.tokens?.refresh_token || a.tokens?.access_token);

  return {
    enabled: ENABLED && authenticated.length > 0,
    accounts: authenticated.map(a => ({
      id: a.id,
      email: a.email,
      lastSync: state[a.id]?.lastSyncTime || 0,
    })),
    nextEventCount: 0, // Would need to cache events to report this accurately
  };
}
