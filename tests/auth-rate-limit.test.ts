import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { EventEmitter } from "events";

const { testDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join: joinPath } = await import("path");
  return { testDir: mkdtempSync(joinPath(tmpdir(), "aria-auth-test-")) };
});

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: testDir,
  WEB_PASSWORD: "correct-horse",
}));

import {
  lockoutRemainingMs,
  recordFailure,
  getClientIp,
  handleLogin,
  isAuthenticated,
  LOGIN_FREE_FAILURES,
  LOGIN_BASE_LOCKOUT_MS,
  LOGIN_MAX_LOCKOUT_MS,
} from "../backend/web/auth.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("lockoutRemainingMs (pure)", () => {
  const now = 1_000_000;

  it("allows unknown clients and the first free failures", () => {
    expect(lockoutRemainingMs(undefined, now)).toBe(0);
    expect(lockoutRemainingMs({ failures: LOGIN_FREE_FAILURES, lastFailureAt: now }, now)).toBe(0);
  });

  it("backs off exponentially after the free failures", () => {
    const f = LOGIN_FREE_FAILURES;
    expect(lockoutRemainingMs({ failures: f + 1, lastFailureAt: now }, now)).toBe(LOGIN_BASE_LOCKOUT_MS);
    expect(lockoutRemainingMs({ failures: f + 2, lastFailureAt: now }, now)).toBe(LOGIN_BASE_LOCKOUT_MS * 2);
    expect(lockoutRemainingMs({ failures: f + 4, lastFailureAt: now }, now)).toBe(LOGIN_BASE_LOCKOUT_MS * 8);
  });

  it("caps the lockout and counts down over time", () => {
    const entry = { failures: 60, lastFailureAt: now };
    expect(lockoutRemainingMs(entry, now)).toBe(LOGIN_MAX_LOCKOUT_MS);
    expect(lockoutRemainingMs(entry, now + LOGIN_MAX_LOCKOUT_MS - 1)).toBe(1);
    expect(lockoutRemainingMs(entry, now + LOGIN_MAX_LOCKOUT_MS)).toBe(0);
  });

  it("recordFailure increments immutably", () => {
    const first = recordFailure(undefined, 5);
    expect(first).toEqual({ failures: 1, lastFailureAt: 5 });
    const second = recordFailure(first, 6);
    expect(second).toEqual({ failures: 2, lastFailureAt: 6 });
    expect(first.failures).toBe(1);
  });
});

describe("getClientIp", () => {
  it("uses the socket address and ignores X-Forwarded-For by default", () => {
    const req = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.9" } } as unknown as IncomingMessage;
    expect(getClientIp(req)).toBe("10.0.0.9");
  });

  it("falls back to 'unknown' without a socket", () => {
    expect(getClientIp({ headers: {} } as unknown as IncomingMessage)).toBe("unknown");
  });
});

// ── handleLogin integration (in-memory req/res) ──

function fakeRequest(body: string, ip: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  Object.assign(req, { headers: {}, socket: { remoteAddress: ip }, destroy: () => undefined });
  process.nextTick(() => {
    req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeResponse(): { res: ServerResponse; status: () => number; body: () => string; headers: () => Record<string, string> } {
  let status = 0;
  let body = "";
  let headers: Record<string, string> = {};
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => { status = code; headers = h ?? {}; return res; },
    end: (chunk?: string) => { body = chunk ?? ""; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body, headers: () => headers };
}

async function login(password: string, ip: string) {
  const out = fakeResponse();
  await handleLogin(fakeRequest(JSON.stringify({ password }), ip), out.res);
  return out;
}

describe("handleLogin", () => {
  it("counts only failures per IP and locks that IP out with exponential backoff", async () => {
    for (let i = 0; i < LOGIN_FREE_FAILURES; i++) {
      expect((await login("wrong", "9.9.9.1")).status()).toBe(401);
    }
    expect((await login("wrong", "9.9.9.1")).status()).toBe(401);   // 4th failure → lockout starts
    const locked = await login("correct-horse", "9.9.9.1");
    expect(locked.status()).toBe(429);
    expect(locked.headers()["Retry-After"]).toBeDefined();
    // A different IP is unaffected
    expect((await login("correct-horse", "9.9.9.2")).status()).toBe(200);
  });

  it("issues a token, stores only its sha256 hash, and authenticates by hash", async () => {
    const out = await login("correct-horse", "9.9.9.3");
    expect(out.status()).toBe(200);
    const { token } = JSON.parse(out.body()) as { token: string };
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const sessionsFile = join(testDir, "sessions.json");
    expect(existsSync(sessionsFile)).toBe(true);
    const raw = readFileSync(sessionsFile, "utf-8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(createHash("sha256").update(token).digest("hex"));

    const authed = { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
    expect(isAuthenticated(authed)).toBe(true);
    const wrong = { headers: { authorization: `Bearer ${"0".repeat(64)}` } } as unknown as IncomingMessage;
    expect(isAuthenticated(wrong)).toBe(false);
  });

  it("successful login clears the failure counter for that IP", async () => {
    await login("wrong", "9.9.9.4");
    await login("wrong", "9.9.9.4");
    expect((await login("correct-horse", "9.9.9.4")).status()).toBe(200);
    for (let i = 0; i < LOGIN_FREE_FAILURES; i++) {
      expect((await login("wrong", "9.9.9.4")).status()).toBe(401);
    }
  });
});
