import { randomBytes, timingSafeEqual, createHash } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { existsSync, readFileSync } from "fs";
import { ensureDir, atomicWriteFile } from "../utils/file-store.js";
import { dirname } from "path";
import { createLogger } from "../logger.js";
import { BRAIN_DIR, WEB_PASSWORD } from "../config.js";

const log = createLogger("web");

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 100;

// ── Login rate limiting (per client IP, failures only, exponential backoff) ──

/** Failures before any lockout kicks in. */
export const LOGIN_FREE_FAILURES = 3;
/** Lockout after the first counted failure; doubles per additional failure. */
export const LOGIN_BASE_LOCKOUT_MS = 1_000;
/** Longest single lockout. */
export const LOGIN_MAX_LOCKOUT_MS = 15 * 60 * 1000;
/** A client with no failures for this long is forgotten. */
export const LOGIN_FAILURE_TTL_MS = 60 * 60 * 1000;
/** Only honour X-Forwarded-For when explicitly behind a trusted proxy. */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "true";

export interface LoginFailureEntry {
  failures: number;
  lastFailureAt: number;
}

/**
 * Pure: how long (ms) the client at `entry` is locked out at `now`.
 * 0 means "allowed". Backoff: 1s, 2s, 4s … capped, starting after
 * LOGIN_FREE_FAILURES consecutive failures.
 */
export function lockoutRemainingMs(entry: LoginFailureEntry | undefined, now: number): number {
  if (!entry || entry.failures <= LOGIN_FREE_FAILURES) return 0;
  const exponent = entry.failures - LOGIN_FREE_FAILURES - 1;
  const lockout = Math.min(LOGIN_BASE_LOCKOUT_MS * 2 ** exponent, LOGIN_MAX_LOCKOUT_MS);
  return Math.max(0, entry.lastFailureAt + lockout - now);
}

/** Pure: entry after one more failure. */
export function recordFailure(entry: LoginFailureEntry | undefined, now: number): LoginFailureEntry {
  return { failures: (entry?.failures ?? 0) + 1, lastFailureAt: now };
}

const loginFailures = new Map<string, LoginFailureEntry>();

function pruneLoginFailures(now: number): void {
  for (const [ip, entry] of loginFailures) {
    if (now - entry.lastFailureAt > LOGIN_FAILURE_TTL_MS) loginFailures.delete(ip);
  }
}

export function getClientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || "unknown";
}

// ── Sessions (hashed at rest) ──

const SESSIONS_FILE = `${BRAIN_DIR}/sessions.json`;

/** sha256(token) hex → created timestamp. Raw tokens never touch disk or memory beyond the login response. */
const activeSessions = new Map<string, number>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function loadSessions(): void {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    for (const [tokenHash, created] of entries) {
      if (now - created < SESSION_TTL) {
        activeSessions.set(tokenHash, created);
      }
    }
    log(`Loaded ${activeSessions.size} sessions from disk`);
  } catch (e) {
    log(`Failed to load sessions: ${e}`);
  }
}

function saveSessions(): void {
  try {
    ensureDir(dirname(SESSIONS_FILE));
    const entries = Array.from(activeSessions.entries());
    atomicWriteFile(SESSIONS_FILE, JSON.stringify(entries));
  } catch (e) {
    log(`Failed to save sessions: ${e}`);
  }
}

// Load persisted sessions on startup
loadSessions();

if (!WEB_PASSWORD) {
  log.warn("WEB_PASSWORD not set — all authenticated endpoints will be inaccessible");
}

export function isPasswordConfigured(): boolean {
  return WEB_PASSWORD.length > 0;
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function getSessionToken(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (match) return match[1];

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  return null;
}

export function isAuthenticated(req: IncomingMessage): boolean {
  if (!WEB_PASSWORD) return false;
  const token = getSessionToken(req);
  if (!token) return false;
  const tokenHash = hashToken(token);
  const created = activeSessions.get(tokenHash);
  if (!created) return false;
  if (Date.now() - created > SESSION_TTL) {
    activeSessions.delete(tokenHash);
    saveSessions();
    return false;
  }
  return true;
}

function safeCompare(a: string, b: string): boolean {
  // Hash both inputs first to prevent length leakage via timing
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

const READ_BODY_TIMEOUT = 30_000; // 30 seconds

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(new Error("Request body timeout"));
      }
    }, READ_BODY_TIMEOUT);

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(body);
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** Drop expired sessions and evict the oldest beyond MAX_SESSIONS. */
function compactSessions(now: number): void {
  for (const [hash, created] of activeSessions) {
    if (now - created > SESSION_TTL) activeSessions.delete(hash);
  }
  if (activeSessions.size > MAX_SESSIONS) {
    const sorted = Array.from(activeSessions.entries()).sort((a, b) => a[1] - b[1]);
    const excess = activeSessions.size - MAX_SESSIONS;
    for (let i = 0; i < excess; i++) {
      activeSessions.delete(sorted[i][0]);
    }
  }
}

function createSession(res: ServerResponse): void {
  const token = generateToken();
  const now = Date.now();
  activeSessions.set(hashToken(token), now);
  log(`Login successful, token: ${token.slice(0, 8)}...`);
  compactSessions(now);
  saveSessions();

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
  });
  // Token included in response body for Nuxt proxy (proxy doesn't forward Set-Cookie).
  // The HttpOnly cookie is also set as defense-in-depth for direct backend access.
  res.end(JSON.stringify({ success: true, token }));
}

export async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = getClientIp(req);
  try {
    const now = Date.now();
    pruneLoginFailures(now);
    const remaining = lockoutRemainingMs(loginFailures.get(ip), now);
    if (remaining > 0) {
      log(`Login rate limited for ${ip} (${Math.ceil(remaining / 1000)}s remaining)`);
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(Math.ceil(remaining / 1000)) });
      res.end(JSON.stringify({ error: "Too many login attempts. Try again later." }));
      return;
    }

    const body = await readBody(req);
    const { password } = JSON.parse(body);

    if (password && WEB_PASSWORD && safeCompare(password, WEB_PASSWORD)) {
      loginFailures.delete(ip);
      createSession(res);
    } else {
      loginFailures.set(ip, recordFailure(loginFailures.get(ip), Date.now()));
      log(`Login failed: wrong password (${ip}, ${loginFailures.get(ip)?.failures} failures)`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid password" }));
    }
  } catch (err) {
    loginFailures.set(ip, recordFailure(loginFailures.get(ip), Date.now()));
    log(`Login request error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}
