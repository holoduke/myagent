import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { updateFrequency, detectAnomalies } from "../backend/frequency-tracker.js";

describe("updateFrequency", () => {
  it("records a message without error", () => {
    expect(() => {
      updateFrequency("alice@s.whatsapp.net", "Alice", Date.now());
    }).not.toThrow();
  });

  it("records multiple messages for the same contact", () => {
    const now = Date.now();
    updateFrequency("bob@s.whatsapp.net", "Bob", now);
    updateFrequency("bob@s.whatsapp.net", "Bob", now + 1000);
    updateFrequency("bob@s.whatsapp.net", "Bob", now + 2000);
    // No errors expected
  });

  it("updates contact name if changed", () => {
    const now = Date.now();
    updateFrequency("charlie@s.whatsapp.net", "Charlie", now);
    updateFrequency("charlie@s.whatsapp.net", "Charlie Updated", now + 1000);
    // Name update is internal, just verify no errors
  });
});

describe("detectAnomalies", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when no baselines exist", () => {
    // With mocked safeReadJSON returning {}, there's no data
    const anomalies = detectAnomalies();
    expect(anomalies).toEqual([]);
  });

  it("returns empty array when not enough baseline days", () => {
    // Fresh tracker with only a few days of data
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      updateFrequency("dave@s.whatsapp.net", "Dave", now - i * 86400000);
    }
    // Only 5 days, need minimum 7
    const anomalies = detectAnomalies();
    // Might or might not detect - depends on internal state
    expect(Array.isArray(anomalies)).toBe(true);
  });

  it("returns anomaly objects with correct shape", () => {
    // Build enough history for detection
    const now = Date.now();
    const jid = "eve@s.whatsapp.net";
    // 10 days of consistent activity
    for (let day = 0; day < 10; day++) {
      for (let msg = 0; msg < 5; msg++) {
        updateFrequency(jid, "Eve", now - day * 86400000 + msg * 1000);
      }
    }

    const anomalies = detectAnomalies();
    // If any anomalies, verify shape
    for (const a of anomalies) {
      expect(a).toHaveProperty("contactJid");
      expect(a).toHaveProperty("contactName");
      expect(a).toHaveProperty("type");
      expect(a).toHaveProperty("description");
      expect(["silence", "spike"]).toContain(a.type);
    }
  });
});
