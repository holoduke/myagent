import { ServerResponse } from "http";
import { createLogger } from "../logger.js";

const log = createLogger("browser-rate-limit");

// ── Configuration ──
const MAX_CONCURRENT_SESSIONS = 3;
const MAX_REQUESTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

// ── State ──
let concurrentSessions = 0;
const requestTimestamps: number[] = [];

function pruneOldTimestamps(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= cutoff) {
    requestTimestamps.shift();
  }
}

/**
 * Check if a browser request should be rate-limited.
 * Returns true if the request was rejected (429 sent), false if allowed.
 */
export function checkBrowserRateLimit(res: ServerResponse): boolean {
  pruneOldTimestamps();

  // Check requests-per-minute
  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const retryAfterSec = Math.ceil((requestTimestamps[0] + WINDOW_MS - Date.now()) / 1000);
    log(`Rate limit exceeded: ${requestTimestamps.length} requests in last minute`);
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) });
    res.end(JSON.stringify({ error: "Too many browser requests. Max 10 per minute.", retryAfterSec }));
    return true;
  }

  // Check concurrent sessions
  if (concurrentSessions >= MAX_CONCURRENT_SESSIONS) {
    log(`Concurrent session limit reached: ${concurrentSessions}/${MAX_CONCURRENT_SESSIONS}`);
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Too many concurrent browser sessions. Max ${MAX_CONCURRENT_SESSIONS}.`, activeSessions: concurrentSessions }));
    return true;
  }

  requestTimestamps.push(Date.now());
  return false;
}

/** Call before starting a browser session/workflow. */
export function acquireBrowserSlot(): void {
  concurrentSessions++;
  log(`Browser slot acquired (${concurrentSessions}/${MAX_CONCURRENT_SESSIONS})`);
}

/** Call when a browser session/workflow completes. */
export function releaseBrowserSlot(): void {
  concurrentSessions = Math.max(0, concurrentSessions - 1);
  log(`Browser slot released (${concurrentSessions}/${MAX_CONCURRENT_SESSIONS})`);
}
