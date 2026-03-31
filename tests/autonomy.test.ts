import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({
    level: 2,
    trustScore: 0,
    successCount: 0,
    failureCount: 0,
    lastLevelChange: Date.now(),
    history: [{ level: 2, timestamp: Date.now(), reason: "initial" }],
  }),
  atomicWriteJSON: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

import {
  getAutonomyLevel,
  getAutonomyState,
  isActionPermitted,
  recordSuccess,
  recordFailure,
  getAutonomySummary,
  resetAutonomyState,
} from "../backend/autonomy.js";

beforeEach(() => {
  resetAutonomyState();
});

describe("getAutonomyLevel", () => {
  it("returns default level 2", () => {
    expect(getAutonomyLevel()).toBe(2);
  });
});

describe("isActionPermitted", () => {
  it("always permits observe", () => {
    expect(isActionPermitted("observe")).toBe(true);
  });

  it("permits suggest at level 2", () => {
    expect(isActionPermitted("suggest")).toBe(true);
  });

  it("denies autonomous_action at level 2", () => {
    expect(isActionPermitted("autonomous_action")).toBe(false);
  });

  it("permits send_message at level 2", () => {
    expect(isActionPermitted("send_message")).toBe(true);
  });

  it("denies send_proactive at level 2", () => {
    expect(isActionPermitted("send_proactive")).toBe(false);
  });
});

describe("recordSuccess", () => {
  it("increments trust score without throwing", () => {
    expect(() => recordSuccess("test_action")).not.toThrow();
  });
});

describe("recordFailure", () => {
  it("decrements trust score without throwing", () => {
    expect(() => recordFailure("test_action", "test reason")).not.toThrow();
  });
});

describe("getAutonomySummary", () => {
  it("returns formatted summary", () => {
    const summary = getAutonomySummary();
    expect(summary).toContain("Level");
    expect(summary).toContain("/4");
  });
});

describe("getAutonomyState", () => {
  it("returns a state object", () => {
    const state = getAutonomyState();
    expect(state.level).toBeDefined();
    expect(state.trustScore).toBeDefined();
    expect(state.successCount).toBeDefined();
    expect(state.failureCount).toBeDefined();
  });
});
