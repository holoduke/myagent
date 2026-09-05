import { describe, it, expect } from "vitest";
import { formatFailureSuffix, formatNoFailureSuffix } from "./brain-watchdog.js";
import type { TickFailureSummary } from "./memory/types.js";

const HOUR = 3_600_000;
const TICK_INTERVAL = 60_000;

describe("formatNoFailureSuffix", () => {
  const now = 10 * HOUR;

  it("points at a silent scheduler when no attempt was ever recorded", () => {
    expect(formatNoFailureSuffix(0, TICK_INTERVAL, now)).toBe(
      " — geen tick-poging geregistreerd (scheduler stil?)",
    );
  });

  it("points at a skip/gate loop when attempts are recent but success is stale", () => {
    const recent = now - TICK_INTERVAL; // < 2x tickInterval
    expect(formatNoFailureSuffix(recent, TICK_INTERVAL, now)).toBe(
      " — ticks worden gepoogd maar geen fout geregistreerd (skip/gate-lus? pendingSelfMod?)",
    );
  });

  it("points at a silent scheduler with elapsed hours when the attempt itself is stale", () => {
    expect(formatNoFailureSuffix(now - 4 * HOUR, TICK_INTERVAL, now)).toBe(
      " — geen tick-poging sinds 4h (scheduler stil)",
    );
  });

  it("formats sub-hour staleness in minutes instead of '0h'", () => {
    expect(formatNoFailureSuffix(now - 10 * 60_000, TICK_INTERVAL, now)).toBe(
      " — geen tick-poging sinds 10m (scheduler stil)",
    );
  });

  it("never returns an empty string (the generic fallback would be lost)", () => {
    for (const attempt of [0, now, now - HOUR, now - 100 * HOUR]) {
      expect(formatNoFailureSuffix(attempt, TICK_INTERVAL, now)).not.toBe("");
    }
  });
});

describe("formatFailureSuffix", () => {
  it("returns empty string without a failure so the no-failure fallback takes over", () => {
    expect(formatFailureSuffix(null)).toBe("");
    expect(formatFailureSuffix(undefined)).toBe("");
  });

  it("names phase, message, kind and count", () => {
    const failure: TickFailureSummary = {
      ts: 1,
      phase: "think",
      message: "API timeout",
      transient: true,
      consecutiveFailures: 6,
    };
    expect(formatFailureSuffix(failure)).toBe(
      " — laatste fout: [think] API timeout (transient, 6x)",
    );
  });
});
