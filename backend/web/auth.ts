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
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW = 15 * 60 * 1000; // 15 minutes


const SESSIONS_FILE = `${BRAIN_DIR}/sessions.json`;

const activeSessions = new Map<string, number>(); // token → created timestamp

function loadSessions(): void {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const raw = readFileSync(SESSIONS_FILE, "utf-8");
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    for (const [token, created] of entries) {
      if (now - created < SESSION_TTL) {
        activeSessions.set(token, created);
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
const loginAttempts: { ts: number }[] = [];

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
  const created = activeSessions.get(token);
  if (!created) return false;
  if (Date.now() - created > SESSION_TTL) {
    activeSessions.delete(token);
    saveSessions();
    return false;
  }
  return true;
}

function isRateLimited(): boolean {
  const now = Date.now();
  while (loginAttempts.length > 0 && now - loginAttempts[0].ts > LOGIN_WINDOW) {
    loginAttempts.shift();
  }
  return loginAttempts.length >= MAX_LOGIN_ATTEMPTS;
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

export async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (isRateLimited()) {
      log("Login rate limited");
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many login attempts. Try again later." }));
      return;
    }

    const body = await readBody(req);
    const { password } = JSON.parse(body);

    loginAttempts.push({ ts: Date.now() });

    if (password && WEB_PASSWORD && safeCompare(password, WEB_PASSWORD)) {
      const token = generateToken();
      activeSessions.set(token, Date.now());
      log(`Login successful, token: ${token.slice(0, 8)}...`);

      // Clean up expired sessions
      const now = Date.now();
      for (const [t, created] of activeSessions) {
        if (now - created > SESSION_TTL) activeSessions.delete(t);
      }

      // Cap active sessions to 100 — evict the oldest when exceeded
      const MAX_SESSIONS = 100;
      if (activeSessions.size > MAX_SESSIONS) {
        const sorted = Array.from(activeSessions.entries()).sort((a, b) => a[1] - b[1]);
        const excess = activeSessions.size - MAX_SESSIONS;
        for (let i = 0; i < excess; i++) {
          activeSessions.delete(sorted[i][0]);
        }
      }

      saveSessions();

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
      });
      // Token included in response body for Nuxt proxy (proxy doesn't forward Set-Cookie).
      // The HttpOnly cookie is also set as defense-in-depth for direct backend access.
      res.end(JSON.stringify({ success: true, token }));
    } else {
      log("Login failed: wrong password");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid password" }));
    }
  } catch (err) {
    log(`Login request error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}
