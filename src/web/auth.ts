import { randomBytes, timingSafeEqual } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [web] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

export const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW = 15 * 60 * 1000; // 15 minutes

const activeSessions = new Map<string, number>(); // token → created timestamp
const loginAttempts: { ts: number }[] = [];
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

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
  const token = getSessionToken(req);
  if (!token) return false;
  const created = activeSessions.get(token);
  if (!created) return false;
  if (Date.now() - created > SESSION_TTL) {
    activeSessions.delete(token);
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
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
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

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
      });
      res.end(JSON.stringify({ success: true, token }));
    } else {
      log("Login failed: wrong password");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid password" }));
    }
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}
