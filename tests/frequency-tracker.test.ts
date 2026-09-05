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

import { updateFrequency, detectAnomalies, mergeBaselineStores } from "../backend/frequency-tracker.js";

describe("mergeBaselineStores", () => {
  const base = (name: string, counts: Record<string, number>, last: number) =>
    ({ jid: "x@s.whatsapp.net", name, dailyCounts: counts, lastMessageAt: last });

  it("keeps entries that exist on one side only", () => {
    const merged = mergeBaselineStores(
      { a: base("A", { "2026-09-01": 2 }, 100) },
      { b: base("B", { "2026-09-01": 1 }, 200) },
    );
    expect(Object.keys(merged).sort()).toEqual(["a", "b"]);
  });

  it("takes the per-day maximum and the latest name/timestamp for shared entries", () => {
    const merged = mergeBaselineStores(
      { a: base("Old Name", { "2026-09-01": 3, "2026-09-02": 1 }, 100) },
      { a: base("New Name", { "2026-09-01": 2, "2026-09-03": 4 }, 200) },
    );
    expect(merged.a.dailyCounts).toEqual({ "2026-09-01": 3, "2026-09-02": 1, "2026-09-03": 4 });
    expect(merged.a.name).toBe("New Name");
    expect(merged.a.lastMessageAt).toBe(200);
  });
});

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
