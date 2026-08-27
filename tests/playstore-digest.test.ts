import { describe, it, expect, vi } from "vitest";

// Deterministic owner-local time helpers (UTC-based) so the gate is testable.
vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC", models: {} }),
  getOwnerLocalTime: (_tz: string, now: Date = new Date()) => ({ hour: now.getUTCHours(), dayOfWeek: now.getUTCDay() }),
  getOwnerLocalDate: (_tz: string, now: Date = new Date()) => now.toISOString().slice(0, 10),
}));

import {
  shouldRunPlayStoreDigest,
  parsePlayStoreDigestHour,
  formatPlayStoreReport,
} from "../backend/playstore-digest.js";
import type { VitalsDay, Review } from "../backend/integrations/playstore.js";

const TZ = "UTC";

describe("parsePlayStoreDigestHour", () => {
  it("returns the default for undefined and blank input", () => {
    expect(parsePlayStoreDigestHour(undefined)).toBe(9);
    expect(parsePlayStoreDigestHour("")).toBe(9);
  });

  it("parses valid hours and rejects invalid input", () => {
    expect(parsePlayStoreDigestHour("8")).toBe(8);
    expect(parsePlayStoreDigestHour("0")).toBe(0);
    expect(parsePlayStoreDigestHour("23")).toBe(23);
    expect(parsePlayStoreDigestHour("9am")).toBe(9);
    expect(parsePlayStoreDigestHour("24")).toBe(9);
    expect(parsePlayStoreDigestHour("-1")).toBe(9);
  });
});

describe("shouldRunPlayStoreDigest", () => {
  it("does not run before the configured hour (default 09:00)", () => {
    expect(shouldRunPlayStoreDigest(0, TZ, new Date("2026-08-27T08:30:00Z"))).toBe(false);
  });

  it("runs at/after the configured hour when it has never run", () => {
    expect(shouldRunPlayStoreDigest(0, TZ, new Date("2026-08-27T09:30:00Z"))).toBe(true);
  });

  it("does not run twice in the same local day", () => {
    const earlier = new Date("2026-08-27T09:05:00Z").getTime();
    expect(shouldRunPlayStoreDigest(earlier, TZ, new Date("2026-08-27T15:00:00Z"))).toBe(false);
  });

  it("runs again on a new local day", () => {
    const yesterday = new Date("2026-08-26T10:00:00Z").getTime();
    expect(shouldRunPlayStoreDigest(yesterday, TZ, new Date("2026-08-27T10:00:00Z"))).toBe(true);
  });
});

function day(date: string, crashRate: number | null, anrRate: number | null, distinctUsers: number | null): VitalsDay {
  return { date, crashRate, anrRate, distinctUsers };
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    date: "2026-08-27",
    lastModifiedMs: Date.now(),
    stars: 5,
    text: "Great app",
    language: "en",
    replied: false,
    ...overrides,
  };
}

describe("formatPlayStoreReport", () => {
  it("shows the latest vitals with trend arrows against the previous day", () => {
    const vitals = [
      day("2026-08-24", 0.004, 0.0006, 11000),
      day("2026-08-25", 0.005, 0.0005, 12345),
    ];
    const out = formatPlayStoreReport("Football Mania", vitals, []);
    expect(out).toContain("Football Mania — Play Store daily");
    expect(out).toContain("Vitals (2026-08-25)");
    expect(out).toContain("Crash rate: 0.50% ↑");
    expect(out).toContain("ANR rate: 0.05% ↓");
    expect(out).toContain("12.3k");
    expect(out).toContain("No new reviews");
  });

  it("handles missing vitals data gracefully", () => {
    const out = formatPlayStoreReport("Football Mania", [], []);
    expect(out).toContain("no data available");
  });

  it("lists new reviews with stars, truncates long text, and counts overflow", () => {
    const reviews = [
      review({ stars: 1, text: "x".repeat(200), language: "de" }),
      review({ stars: 5 }),
      review({ stars: 4 }),
      review({ stars: 3 }),
      review({ stars: 2 }),
    ];
    const out = formatPlayStoreReport("Football Mania", [], reviews);
    expect(out).toContain("New reviews (5)");
    expect(out).toContain("★☆☆☆☆ [de]");
    expect(out).toContain("…and 1 more.");
    expect(out).not.toContain("x".repeat(141));
  });

  it("flags unreplied low-star reviews", () => {
    const reviews = [
      review({ stars: 1, replied: false }),
      review({ stars: 2, replied: false }),
      review({ stars: 5, replied: false }),
      review({ stars: 1, replied: true }),
    ];
    const out = formatPlayStoreReport("Football Mania", [], reviews);
    expect(out).toContain("2 low-star reviews without a reply");
  });
});
