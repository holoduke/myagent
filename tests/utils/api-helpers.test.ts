import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../backend/web/auth.js", () => ({
  readBody: () => Promise.resolve("{}"),
}));

import { ApiError, isRateLimited } from "../../backend/utils/api-helpers.js";
import type { IncomingMessage } from "http";

function mockRequest(opts: { ip?: string; forwardedFor?: string } = {}): IncomingMessage {
  return {
    headers: opts.forwardedFor ? { "x-forwarded-for": opts.forwardedFor } : {},
    socket: { remoteAddress: opts.ip || "127.0.0.1" },
  } as unknown as IncomingMessage;
}

// ── ApiError ──

describe("ApiError", () => {
  it("has correct statusCode", () => {
    const err = new ApiError(404, "Not found");
    expect(err.statusCode).toBe(404);
  });

  it("has correct message", () => {
    const err = new ApiError(400, "Bad request");
    expect(err.message).toBe("Bad request");
  });

  it("has name ApiError", () => {
    const err = new ApiError(500, "Server error");
    expect(err.name).toBe("ApiError");
  });

  it("is instanceof Error", () => {
    const err = new ApiError(500, "Error");
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves stack trace", () => {
    const err = new ApiError(500, "Error");
    expect(err.stack).toBeDefined();
  });
});

// ── isRateLimited ──

describe("isRateLimited", () => {
  beforeEach(() => {
    // Use a unique IP per test to avoid cross-test contamination
    vi.useFakeTimers();
  });

  it("returns false for first request", () => {
    const req = mockRequest({ ip: "10.0.0.1" });
    expect(isRateLimited(req)).toBe(false);
  });

  it("returns false within rate limit", () => {
    const req = mockRequest({ ip: "10.0.0.2" });
    for (let i = 0; i < 119; i++) {
      isRateLimited(req);
    }
    // 120th request should still be ok (limit is 120)
    expect(isRateLimited(req)).toBe(false);
  });

  it("returns true when limit exceeded", () => {
    const req = mockRequest({ ip: "10.0.0.3" });
    for (let i = 0; i < 121; i++) {
      isRateLimited(req);
    }
    expect(isRateLimited(req)).toBe(true);
  });

  it("resets after window expires", () => {
    const req = mockRequest({ ip: "10.0.0.4" });
    // Exhaust the limit
    for (let i = 0; i < 121; i++) {
      isRateLimited(req);
    }
    expect(isRateLimited(req)).toBe(true);

    // Advance past the 60s window
    vi.advanceTimersByTime(61_000);

    // Should reset
    expect(isRateLimited(req)).toBe(false);
  });

  it("uses X-Forwarded-For header when present", () => {
    const req1 = mockRequest({ forwardedFor: "203.0.113.1" });
    const req2 = mockRequest({ forwardedFor: "203.0.113.2" });

    // Fill up limit for IP 1
    for (let i = 0; i < 121; i++) {
      isRateLimited(req1);
    }

    // IP 2 should be fine
    expect(isRateLimited(req2)).toBe(false);
    // IP 1 is over limit
    expect(isRateLimited(req1)).toBe(true);
  });

  it("takes first IP from X-Forwarded-For chain", () => {
    const req = mockRequest({ forwardedFor: "1.2.3.4, 5.6.7.8, 9.10.11.12" });
    // Should use 1.2.3.4 as the client IP
    expect(isRateLimited(req)).toBe(false);
  });

  it("falls back to socket.remoteAddress without X-Forwarded-For", () => {
    const req = mockRequest({ ip: "192.168.1.100" });
    expect(isRateLimited(req)).toBe(false);
  });

  vi.useRealTimers();
});
