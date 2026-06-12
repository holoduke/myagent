import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { info: () => {}, warn: () => {}, error: () => {} },
  ),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => [],
  atomicWriteJSON: () => {},
  ensureDir: () => {},
  FileStore: class {
    load() { return []; }
    save() {}
  },
}));

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC" }),
  getOwnerLocalTime: (_tz: string, now: Date) => ({
    hour: now.getUTCHours(),
    dayOfWeek: now.getUTCDay(),
  }),
  getOwnerLocalDate: (_tz: string, now: Date = new Date()) => now.toISOString().slice(0, 10),
}));

import { isDue, isValidTask, validatePattern } from "../backend/recurring.js";
import type { RecurringTask } from "../backend/recurring.js";

function makeTask(overrides: Partial<RecurringTask> = {}): RecurringTask {
  return {
    id: "test_task",
    type: "digest",
    label: "Test Task",
    pattern: { hours: [8] },
    action: { type: "digest", targetJid: "owner@s.whatsapp.net" },
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: 0,
    source: "owner",
    ...overrides,
  };
}

// ── isDue ──

describe("isDue", () => {
  it("returns false for disabled task", () => {
    const task = makeTask({ enabled: false });
    const now = new Date("2024-01-15T08:00:00Z");
    expect(isDue(task, now)).toBe(false);
  });

  it("returns true when hour matches and task never ran", () => {
    const task = makeTask({ pattern: { hours: [14] }, lastRunAt: 0 });
    const now = new Date("2024-01-15T14:00:00Z");
    expect(isDue(task, now)).toBe(true);
  });

  it("returns false when hour does not match", () => {
    const task = makeTask({ pattern: { hours: [8] } });
    const now = new Date("2024-01-15T15:00:00Z");
    expect(isDue(task, now)).toBe(false);
  });

  it("returns false when already ran during the same hour+day window", () => {
    // Same-window dedup: ran at 08:05, checking again at 08:30 — same clock hour, skip.
    const now = new Date("2024-01-15T08:30:00Z");
    const task = makeTask({
      pattern: { hours: [8] },
      lastRunAt: new Date("2024-01-15T08:05:00Z").getTime(),
    });
    expect(isDue(task, now)).toBe(false);
  });

  it("returns true when the last run was in a different (earlier) hour", () => {
    // Last run was in hour 7; now we're in matching hour 8 — different window, due again.
    const now = new Date("2024-01-15T08:00:00Z");
    const task = makeTask({
      pattern: { hours: [8] },
      lastRunAt: new Date("2024-01-15T07:00:00Z").getTime(),
    });
    expect(isDue(task, now)).toBe(true);
  });

  it("respects daysOfWeek filter — matches", () => {
    // 2024-01-14 is a Sunday (0)
    const now = new Date("2024-01-14T10:00:00Z");
    const task = makeTask({
      pattern: { hours: [10], daysOfWeek: [0] }, // Sunday only
    });
    expect(isDue(task, now)).toBe(true);
  });

  it("respects daysOfWeek filter — no match", () => {
    // 2024-01-15 is a Monday (1)
    const now = new Date("2024-01-15T10:00:00Z");
    const task = makeTask({
      pattern: { hours: [10], daysOfWeek: [0] }, // Sunday only
    });
    expect(isDue(task, now)).toBe(false);
  });

  it("matches any day when daysOfWeek not specified", () => {
    const task = makeTask({ pattern: { hours: [8] } }); // no daysOfWeek
    const monday = new Date("2024-01-15T08:00:00Z");
    const saturday = new Date("2024-01-20T08:00:00Z");
    expect(isDue(task, monday)).toBe(true);
    expect(isDue(task, saturday)).toBe(true);
  });

  it("matches multiple hours", () => {
    const task = makeTask({ pattern: { hours: [8, 12, 18] } });
    expect(isDue(task, new Date("2024-01-15T08:00:00Z"))).toBe(true);
    expect(isDue(task, new Date("2024-01-15T12:00:00Z"))).toBe(true);
    expect(isDue(task, new Date("2024-01-15T18:00:00Z"))).toBe(true);
    expect(isDue(task, new Date("2024-01-15T15:00:00Z"))).toBe(false);
  });
});

// ── isValidTask ──

describe("isValidTask", () => {
  it("returns true for valid task", () => {
    expect(isValidTask(makeTask())).toBe(true);
  });

  it("returns false for null", () => {
    expect(isValidTask(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isValidTask(undefined)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(isValidTask("string")).toBe(false);
    expect(isValidTask(42)).toBe(false);
  });

  it("returns false when id is missing", () => {
    const task = { ...makeTask() };
    delete (task as Record<string, unknown>).id;
    expect(isValidTask(task)).toBe(false);
  });

  it("returns false when enabled is not boolean", () => {
    const task = { ...makeTask(), enabled: "yes" };
    expect(isValidTask(task)).toBe(false);
  });

  it("returns false when pattern.hours is empty", () => {
    const task = { ...makeTask(), pattern: { hours: [] } };
    expect(isValidTask(task)).toBe(false);
  });

  it("returns false for invalid hour values", () => {
    expect(isValidTask({ ...makeTask(), pattern: { hours: [25] } })).toBe(false);
    expect(isValidTask({ ...makeTask(), pattern: { hours: [-1] } })).toBe(false);
    expect(isValidTask({ ...makeTask(), pattern: { hours: [8.5] } })).toBe(false);
  });

  it("returns false for invalid daysOfWeek values", () => {
    expect(isValidTask({ ...makeTask(), pattern: { hours: [8], daysOfWeek: [7] } })).toBe(false);
    expect(isValidTask({ ...makeTask(), pattern: { hours: [8], daysOfWeek: [-1] } })).toBe(false);
  });

  it("returns true with valid daysOfWeek", () => {
    expect(isValidTask({ ...makeTask(), pattern: { hours: [8], daysOfWeek: [0, 1, 6] } })).toBe(true);
  });
});

// ── validatePattern ──

describe("validatePattern", () => {
  it("does not throw for valid pattern", () => {
    expect(() => validatePattern({ hours: [0, 12, 23] })).not.toThrow();
  });

  it("does not throw with valid daysOfWeek", () => {
    expect(() => validatePattern({ hours: [8], daysOfWeek: [0, 3, 6] })).not.toThrow();
  });

  it("throws for hour < 0", () => {
    expect(() => validatePattern({ hours: [-1] })).toThrow("Invalid hour");
  });

  it("throws for hour > 23", () => {
    expect(() => validatePattern({ hours: [24] })).toThrow("Invalid hour");
  });

  it("throws for non-integer hour", () => {
    expect(() => validatePattern({ hours: [8.5] })).toThrow("Invalid hour");
  });

  it("throws for daysOfWeek < 0", () => {
    expect(() => validatePattern({ hours: [8], daysOfWeek: [-1] })).toThrow("Invalid daysOfWeek");
  });

  it("throws for daysOfWeek > 6", () => {
    expect(() => validatePattern({ hours: [8], daysOfWeek: [7] })).toThrow("Invalid daysOfWeek");
  });
});
