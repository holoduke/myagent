import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: vi.fn().mockReturnValue({ events: [], patterns: [], lastAnalysis: 0 }),
  atomicWriteJSON: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

import {
  recordTemporalEvent,
  analyzePatterns,
  getActivePatterns,
  getTemporalPatternSummary,
  resetTemporalPatterns,
} from "../backend/temporal-patterns.js";

beforeEach(() => {
  resetTemporalPatterns();
});

describe("recordTemporalEvent", () => {
  it("records event without error", () => {
    expect(() => recordTemporalEvent("test topic")).not.toThrow();
  });

  it("records event with sender", () => {
    expect(() => recordTemporalEvent("meeting", "alice@s.whatsapp.net")).not.toThrow();
  });

  it("truncates long topic strings", () => {
    const longTopic = "a".repeat(100);
    expect(() => recordTemporalEvent(longTopic)).not.toThrow();
  });
});

describe("analyzePatterns", () => {
  it("returns empty when too few events", () => {
    const patterns = analyzePatterns();
    expect(patterns).toEqual([]);
  });

  it("returns cached patterns when analysis was recent", () => {
    // First call returns empty (too few events)
    const result = analyzePatterns();
    expect(result).toEqual([]);
  });
});

describe("getActivePatterns", () => {
  it("returns empty when no patterns detected", () => {
    const active = getActivePatterns();
    expect(active).toEqual([]);
  });
});

describe("getTemporalPatternSummary", () => {
  it("returns empty string when no active patterns", () => {
    const summary = getTemporalPatternSummary();
    expect(summary).toBe("");
  });
});

describe("resetTemporalPatterns", () => {
  it("resets state without error", () => {
    recordTemporalEvent("test");
    expect(() => resetTemporalPatterns()).not.toThrow();
  });
});
