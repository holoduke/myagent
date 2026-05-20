import { describe, expect, it } from "vitest";
import { evaluateWatchdog } from "../backend/brain-watchdog.js";

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
