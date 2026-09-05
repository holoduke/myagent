import { describe, it, expect } from "vitest";
import { zonedDateTimeToDate, wallClockIn, localYmd } from "../../backend/utils/timezone.js";

describe("zonedDateTimeToDate", () => {
  it("resolves Amsterdam summer time (UTC+2)", () => {
    const d = zonedDateTimeToDate("2026-07-01", "10:00", "Europe/Amsterdam");
    expect(d?.toISOString()).toBe("2026-07-01T08:00:00.000Z");
  });

  it("resolves Amsterdam winter time (UTC+1)", () => {
    const d = zonedDateTimeToDate("2026-01-15", "09:30", "Europe/Amsterdam");
    expect(d?.toISOString()).toBe("2026-01-15T08:30:00.000Z");
  });

  it("handles UTC and a western zone", () => {
    expect(zonedDateTimeToDate("2026-03-01", "12:00", "UTC")?.toISOString()).toBe("2026-03-01T12:00:00.000Z");
    expect(zonedDateTimeToDate("2026-03-01", "12:00", "America/New_York")?.toISOString()).toBe("2026-03-01T17:00:00.000Z");
  });

  it("round-trips through wallClockIn", () => {
    const d = zonedDateTimeToDate("2026-10-25", "02:30", "Europe/Amsterdam")!;
    const wc = wallClockIn(d, "Europe/Amsterdam");
    expect([wc.year, wc.month, wc.day]).toEqual([2026, 10, 25]);
    expect(wc.hour).toBe(2);
    expect(wc.minute).toBe(30);
  });

  it("returns null on malformed input", () => {
    expect(zonedDateTimeToDate("2026-13-01", "10:00", "UTC")).toBeNull();
    expect(zonedDateTimeToDate("tomorrow", "10:00", "UTC")).toBeNull();
    expect(zonedDateTimeToDate("2026-01-01", "25:00", "UTC")).toBeNull();
  });
});

describe("localYmd", () => {
  it("formats the local calendar date with zero padding", () => {
    expect(localYmd(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});
