import { describe, expect, it } from "vitest";
import { evaluateWatchdog, resolveAlertAfterMs, DEFAULT_ALERT_AFTER_MS, MIN_ALERT_AFTER_MS } from "../backend/brain-watchdog.js";

describe("alert threshold", () => {
  const HOUR = 60 * 60 * 1000;

  it("defaults to 5h, above the 4h idle think interval plus the longest tick budget", () => {
    expect(DEFAULT_ALERT_AFTER_MS).toBe(5 * HOUR);
    expect(DEFAULT_ALERT_AFTER_MS).toBeGreaterThan(MIN_ALERT_AFTER_MS);
    expect(MIN_ALERT_AFTER_MS).toBe(4 * HOUR + 630_000);
  });

  it("never lets a configured threshold drop below the idle floor", () => {
    expect(resolveAlertAfterMs(undefined)).toBe(DEFAULT_ALERT_AFTER_MS);
    expect(resolveAlertAfterMs(2 * HOUR)).toBe(MIN_ALERT_AFTER_MS);
    expect(resolveAlertAfterMs(8 * HOUR)).toBe(8 * HOUR);
  });

  it("a healthy idle brain (one think every 4h) never reaches alert at the default threshold", () => {
    expect(evaluateWatchdog(4 * HOUR + 600_000, 60 * 60 * 1000, DEFAULT_ALERT_AFTER_MS).level).toBe("warn");
  });
});

describe("evaluateWatchdog", () => {
  const warn = 60 * 60 * 1000;       // 1h
  const alert = 4 * 60 * 60 * 1000;  // 4h

  it("returns ok when below warn threshold", () => {
    expect(evaluateWatchdog(0, warn, alert).level).toBe("ok");
    expect(evaluateWatchdog(warn - 1, warn, alert).level).toBe("ok");
  });

  it("returns warn at warn threshold", () => {
    expect(evaluateWatchdog(warn, warn, alert).level).toBe("warn");
    expect(evaluateWatchdog(warn + 1, warn, alert).level).toBe("warn");
  });

  it("returns warn between warn and alert", () => {
    expect(evaluateWatchdog(2 * 60 * 60 * 1000, warn, alert).level).toBe("warn");
  });

  it("returns alert at alert threshold", () => {
    expect(evaluateWatchdog(alert, warn, alert).level).toBe("alert");
    expect(evaluateWatchdog(alert + 1, warn, alert).level).toBe("alert");
  });

  it("includes msSinceSuccess in result", () => {
    const r = evaluateWatchdog(123_456, warn, alert);
    expect(r.msSinceSuccess).toBe(123_456);
  });

  it("alert dominates warn when both could apply", () => {
    expect(evaluateWatchdog(99 * 60 * 60 * 1000, warn, alert).level).toBe("alert");
  });
});
