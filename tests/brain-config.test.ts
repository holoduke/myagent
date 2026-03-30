import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

import {
  getOwnerLocalTime,
  getOwnerLocalDate,
  getOwnerLocalDay,
  getActivePreset,
  getCharacterPreset,
  BRAIN_PRESETS,
  CHARACTER_PRESETS,
} from "../backend/brain-config.js";
import type { BrainConfig } from "../backend/brain-config.js";

// ── getOwnerLocalTime ──

describe("getOwnerLocalTime", () => {
  it("returns correct hour and day for UTC", () => {
    // 2024-01-15 is a Monday, 14:30 UTC
    const date = new Date("2024-01-15T14:30:00Z");
    const result = getOwnerLocalTime("UTC", date);
    expect(result.hour).toBe(14);
    expect(result.dayOfWeek).toBe(1); // Monday
  });

  it("converts timezone correctly (Europe/Amsterdam = UTC+1 in winter)", () => {
    // 2024-01-15 23:30 UTC → 2024-01-16 00:30 CET (Tuesday)
    const date = new Date("2024-01-15T23:30:00Z");
    const result = getOwnerLocalTime("Europe/Amsterdam", date);
    expect(result.hour).toBe(0);
    expect(result.dayOfWeek).toBe(2); // Tuesday in Amsterdam
  });

  it("handles summer time (CEST = UTC+2)", () => {
    // 2024-07-15 10:00 UTC → 12:00 CEST
    const date = new Date("2024-07-15T10:00:00Z");
    const result = getOwnerLocalTime("Europe/Amsterdam", date);
    expect(result.hour).toBe(12);
  });

  it("falls back to system time for invalid timezone", () => {
    const date = new Date("2024-01-15T14:30:00Z");
    const result = getOwnerLocalTime("Invalid/Zone", date);
    // Should not throw, returns some hour
    expect(result.hour).toBeGreaterThanOrEqual(0);
    expect(result.hour).toBeLessThanOrEqual(23);
  });

  it("returns Sunday=0 through Saturday=6", () => {
    // 2024-01-14 is a Sunday
    const sunday = new Date("2024-01-14T12:00:00Z");
    expect(getOwnerLocalTime("UTC", sunday).dayOfWeek).toBe(0);

    // 2024-01-20 is a Saturday
    const saturday = new Date("2024-01-20T12:00:00Z");
    expect(getOwnerLocalTime("UTC", saturday).dayOfWeek).toBe(6);
  });

  it("handles midnight correctly", () => {
    const midnight = new Date("2024-01-15T00:00:00Z");
    const result = getOwnerLocalTime("UTC", midnight);
    expect(result.hour).toBe(0);
  });
});

// ── getOwnerLocalDate ──

describe("getOwnerLocalDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const date = new Date("2024-03-15T12:00:00Z");
    const result = getOwnerLocalDate("UTC", date);
    expect(result).toBe("2024-03-15");
  });

  it("accounts for timezone in date", () => {
    // Late night UTC → next day in Amsterdam
    const date = new Date("2024-03-15T23:30:00Z");
    const result = getOwnerLocalDate("Europe/Amsterdam", date);
    expect(result).toBe("2024-03-16");
  });

  it("falls back to ISO date for invalid timezone", () => {
    const date = new Date("2024-03-15T12:00:00Z");
    const result = getOwnerLocalDate("Invalid/Zone", date);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── getOwnerLocalDay ──

describe("getOwnerLocalDay", () => {
  it("returns 0 for Sunday", () => {
    const sunday = new Date("2024-01-14T12:00:00Z");
    expect(getOwnerLocalDay("UTC", sunday)).toBe(0);
  });

  it("returns 6 for Saturday", () => {
    const saturday = new Date("2024-01-20T12:00:00Z");
    expect(getOwnerLocalDay("UTC", saturday)).toBe(6);
  });

  it("accounts for timezone when day wraps", () => {
    // Monday 23:30 UTC → Tuesday 00:30 CET
    const date = new Date("2024-01-15T23:30:00Z");
    expect(getOwnerLocalDay("Europe/Amsterdam", date)).toBe(2); // Tuesday
  });
});

// ── getActivePreset ──

describe("getActivePreset", () => {
  function makeConfig(overrides: Partial<BrainConfig> = {}): BrainConfig {
    return {
      enabled: true,
      maxMessagesPerDay: 5,
      minMessageInterval: 7200000,
      quietStart: 23,
      quietEnd: 7,
      ownerTimezone: "Europe/Amsterdam",
      thinkCooldown: 300000,
      consolidateInterval: 14400000,
      reflectInterval: 21600000,
      tickInterval: 60000,
      preset: null,
      selfImproveEnabled: true,
      selfImproveAutoApprove: false,
      selfImproveMaxPerWeek: 3,
      urgencyInterruptThreshold: 0.8,
      characterType: "default",
      characterCustomPrompt: null,
      detectionMode: "prompt",
      detectionPrompt: null,
      activationSpreadFactor: 0.6,
      archiveRecallMin: 5,
      archiveRecallMax: 15,
      archiveRecallDivisor: 400,
      maxThinkContextNodes: 35,
      ...overrides,
    };
  }

  it("returns preset name when explicitly set", () => {
    expect(getActivePreset(makeConfig({ preset: "quiet" }))).toBe("quiet");
  });

  it("auto-detects normal preset", () => {
    const config = makeConfig({
      maxMessagesPerDay: 5,
      minMessageInterval: 7200000,
      quietStart: 23,
      quietEnd: 7,
    });
    expect(getActivePreset(config)).toBe("normal");
  });

  it("auto-detects silent preset", () => {
    const config = makeConfig({
      maxMessagesPerDay: 0,
      minMessageInterval: 86400000,
      quietStart: 0,
      quietEnd: 24,
    });
    expect(getActivePreset(config)).toBe("silent");
  });

  it("auto-detects quiet preset", () => {
    const config = makeConfig({
      maxMessagesPerDay: 2,
      minMessageInterval: 14400000,
      quietStart: 22,
      quietEnd: 9,
    });
    expect(getActivePreset(config)).toBe("quiet");
  });

  it("auto-detects active preset", () => {
    const config = makeConfig({
      maxMessagesPerDay: 10,
      minMessageInterval: 3600000,
      quietStart: 0,
      quietEnd: 0,
    });
    expect(getActivePreset(config)).toBe("active");
  });

  it("returns null when no preset matches", () => {
    const config = makeConfig({
      maxMessagesPerDay: 42,
      minMessageInterval: 999,
      quietStart: 3,
      quietEnd: 4,
    });
    expect(getActivePreset(config)).toBeNull();
  });
});

// ── getCharacterPreset ──

describe("getCharacterPreset", () => {
  it("returns preset for known names", () => {
    for (const preset of CHARACTER_PRESETS) {
      const result = getCharacterPreset(preset.name);
      expect(result).toBeDefined();
      expect(result!.name).toBe(preset.name);
    }
  });

  it("returns undefined for unknown name", () => {
    expect(getCharacterPreset("nonexistent")).toBeUndefined();
  });

  it("default preset has expected properties", () => {
    const preset = getCharacterPreset("default");
    expect(preset).toBeDefined();
    expect(preset!.label).toBe("Default (ARIA)");
    expect(preset!.traits).toContain("Sharp");
    expect(preset!.voice).toContain("real person");
  });

  it("all presets have required fields", () => {
    for (const preset of CHARACTER_PRESETS) {
      expect(preset.name).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.traits).toBeTruthy();
      expect(preset.voice).toBeTruthy();
    }
  });
});

// ── BRAIN_PRESETS ──

describe("BRAIN_PRESETS", () => {
  it("has exactly 4 presets", () => {
    expect(BRAIN_PRESETS).toHaveLength(4);
  });

  it("each preset has required fields", () => {
    for (const preset of BRAIN_PRESETS) {
      expect(preset.name).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.values).toBeDefined();
    }
  });
});
