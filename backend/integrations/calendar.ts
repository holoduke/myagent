import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import { recordObservation } from "../observer.js";
import { loadAccounts, createOAuth2Client } from "./gmail.js";
import { isIntegrationEnabled } from "./integration-config.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [calendar] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const CALENDAR_DIR = "/data/calendar";
const STATE_FILE = `${CALENDAR_DIR}/state.json`;
const POLL_INTERVAL = Number(process.env.CALENDAR_POLL_INTERVAL ?? 300000);
const ENABLED = process.env.CALENDAR_ENABLED !== "false";

interface CalendarState {
  [accountId: string]: {
    lastSyncTime: number;
  };
}

function ensureDir(): void {
  if (!existsSync(CALENDAR_DIR)) {
    mkdirSync(CALENDAR_DIR, { recursive: true });
  }
}

function loadState(): CalendarState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load calendar state: ${err}`);
  }
  return {};
}

function saveState(state: CalendarState): void {
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
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
    for (const event of events) {
      if (!event.id || !event.summary) continue;

      const start = event.start?.dateTime || event.start?.date || "";
      const end = event.end?.dateTime || event.end?.date || "";
      const location = event.location || "";

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

    log(`Fetched ${events.length} upcoming events for ${accountId}`);
  } catch (err: any) {
    if (err.code === 401) {
      log(`Calendar auth expired for ${accountId}`);
    } else {
      log(`Calendar poll failed for ${accountId}: ${err.message || err}`);
    }
  }
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
): Promise<{ success: boolean; eventId?: string; error?: string }> {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account || (!account.tokens?.refresh_token && !account.tokens?.access_token)) {
    return { success: false, error: "Account not found or not authenticated" };
  }

  const auth = createOAuth2Client(account);
  const calendar = google.calendar({ version: "v3", auth });

  try {
    const res = await calendar.events.insert({
      calendarId: "primary",
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
