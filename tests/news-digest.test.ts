import { describe, it, expect, vi } from "vitest";

// Deterministic owner-local time helpers (UTC-based) so the gate is testable.
vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC", models: {} }),
  getOwnerLocalTime: (_tz: string, now: Date) => ({ hour: now.getUTCHours(), dayOfWeek: now.getUTCDay() }),
  getOwnerLocalDate: (_tz: string, now: Date = new Date()) => now.toISOString().slice(0, 10),
}));

import { shouldRunNewsDigest } from "../backend/news-digest.js";

const TZ = "UTC";

describe("shouldRunNewsDigest", () => {
  it("does not run before the configured hour (default 07:00)", () => {
    const now = new Date("2026-06-12T06:30:00Z");
    expect(shouldRunNewsDigest(0, TZ, now)).toBe(false);
  });

  it("runs at/after the configured hour when it has never run", () => {
    const now = new Date("2026-06-12T07:30:00Z");
    expect(shouldRunNewsDigest(0, TZ, now)).toBe(true);
  });

  it("does not run twice in the same local day", () => {
    const earlier = new Date("2026-06-12T07:05:00Z").getTime();
    const now = new Date("2026-06-12T15:00:00Z");
    expect(shouldRunNewsDigest(earlier, TZ, now)).toBe(false);
  });

  it("runs again on a new local day", () => {
    const yesterday = new Date("2026-06-11T08:00:00Z").getTime();
    const now = new Date("2026-06-12T08:00:00Z");
    expect(shouldRunNewsDigest(yesterday, TZ, now)).toBe(true);
  });

  it("still gated by hour even on a new day", () => {
    const yesterday = new Date("2026-06-11T08:00:00Z").getTime();
    const now = new Date("2026-06-12T05:00:00Z");
    expect(shouldRunNewsDigest(yesterday, TZ, now)).toBe(false);
  });
});
