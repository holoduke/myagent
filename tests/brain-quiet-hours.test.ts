import { describe, it, expect } from "vitest";
import { isQuietHour, quietEndDeliverAt, ownerLocalClock } from "../backend/brain-quiet-hours.js";

const HOUR = 3600_000;
const MIN = 60_000;

describe("isQuietHour", () => {
  it("handles overnight ranges", () => {
    expect(isQuietHour(23, 23, 7)).toBe(true);
    expect(isQuietHour(3, 23, 7)).toBe(true);
    expect(isQuietHour(7, 23, 7)).toBe(false);
    expect(isQuietHour(12, 23, 7)).toBe(false);
  });

  it("handles same-day ranges and the disabled case", () => {
    expect(isQuietHour(10, 8, 22)).toBe(true);
    expect(isQuietHour(23, 8, 22)).toBe(false);
    expect(isQuietHour(5, 0, 0)).toBe(false);
  });
});

describe("quietEndDeliverAt", () => {
  it("returns now when outside quiet hours", () => {
    expect(quietEndDeliverAt(1_000_000, { hour: 12, minute: 30 }, 23, 7)).toBe(1_000_000);
  });

  it("defers to the start of the quietEnd hour, dropping the minute offset", () => {
    // 23:45 owner-local, quiet 23→7: deliver at 07:00 = 7h15m later
    const now = 50 * HOUR + 45 * MIN;
    const at = quietEndDeliverAt(now, { hour: 23, minute: 45 }, 23, 7);
    expect(at - now).toBe(7 * HOUR + 15 * MIN);
  });

  it("handles being inside the early-morning part of an overnight window", () => {
    const now = 100 * HOUR + 10 * MIN;
    const at = quietEndDeliverAt(now, { hour: 4, minute: 10 }, 23, 7);
    expect(at - now).toBe(3 * HOUR - 10 * MIN);
  });

  it("never returns a time in the past", () => {
    const now = 77 * HOUR + 59 * MIN;
    expect(quietEndDeliverAt(now, { hour: 6, minute: 59 }, 23, 7)).toBeGreaterThan(now);
  });
});

describe("ownerLocalClock", () => {
  it("converts to the owner's timezone", () => {
    // 2026-01-15T10:30:00Z → 11:30 in Amsterdam (CET, UTC+1)
    const now = Date.UTC(2026, 0, 15, 10, 30);
    expect(ownerLocalClock("Europe/Amsterdam", now)).toEqual({ hour: 11, minute: 30 });
  });

  it("handles half-hour offset zones", () => {
    const now = Date.UTC(2026, 0, 15, 10, 0);
    expect(ownerLocalClock("Asia/Kolkata", now)).toEqual({ hour: 15, minute: 30 });
  });

  it("falls back to system time on an invalid timezone", () => {
    const now = Date.now();
    const clock = ownerLocalClock("Not/AZone", now);
    expect(clock.hour).toBe(new Date(now).getHours());
  });
});
