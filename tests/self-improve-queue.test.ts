import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rmSync } from "fs";

const { testDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  return { testDir: mkdtempSync(join(tmpdir(), "aria-queue-test-")) };
});

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: testDir,
  GITHUB_REPO: "holoduke/myagent",
}));

import {
  enqueue,
  enqueueApproved,
  dequeueApproved,
  deleteItem,
  completeItem,
  failItem,
  markMergePending,
  recordMergeFailure,
  selectMergeCandidates,
  loadQueue,
  loadHistory,
  saveQueue,
  saveHistory,
  countAttemptsOnDay,
  countConsecutiveFailuresToday,
  findLastMergeAt,
} from "../backend/self-improve-queue.js";
import type { QueueItem } from "../backend/self-improve-queue.js";

const localDateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const today = "2026-09-05";
const todayMs = new Date("2026-09-05T10:00:00Z").getTime();
const yesterdayMs = new Date("2026-09-04T10:00:00Z").getTime();

function item(status: QueueItem["status"], extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: `si_${Math.random().toString(36).slice(2, 10)}`,
    task: { type: "improvement", description: "x", rationale: "", files: [], memoryContext: [], planNodeId: "", createdAt: 0 },
    status,
    createdAt: 0,
    ...extra,
  };
}

const task = { type: "improvement", description: "desc", rationale: "why", files: [], memoryContext: [], planNodeId: "", createdAt: 0 };

beforeEach(() => {
  saveQueue({ items: [] });
  saveHistory({ entries: [] });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("pure budget helpers", () => {
  it("countAttemptsOnDay counts completed and failed items from today", () => {
    const entries = [
      item("completed", { completedAt: todayMs }),
      item("failed", { completedAt: todayMs }),
      item("completed", { completedAt: yesterdayMs }),
      item("rejected", { completedAt: todayMs }),
    ];
    expect(countAttemptsOnDay(entries, localDateOf, today)).toBe(2);
  });

  it("countConsecutiveFailuresToday stops at the first non-failure", () => {
    const entries = [
      item("failed", { completedAt: todayMs + 3 }),
      item("rejected"),
      item("failed", { completedAt: todayMs + 2 }),
      item("completed", { completedAt: todayMs + 1 }),
      item("failed", { completedAt: todayMs }),
    ];
    expect(countConsecutiveFailuresToday(entries, localDateOf, today)).toBe(2);
  });

  it("countConsecutiveFailuresToday ignores yesterday's failures", () => {
    expect(countConsecutiveFailuresToday([item("failed", { completedAt: yesterdayMs })], localDateOf, today)).toBe(0);
  });

  it("findLastMergeAt picks the newest mergedAt", () => {
    expect(findLastMergeAt([item("completed", { mergedAt: 5 }), item("completed", { mergedAt: 9 }), item("completed")])).toBe(9);
    expect(findLastMergeAt([])).toBe(0);
  });

  it("selectMergeCandidates returns due merge items oldest first", () => {
    const due = item("merge-pending", { createdAt: 2, nextMergeAttemptAt: 100 });
    const older = item("merge-failed", { createdAt: 1, nextMergeAttemptAt: 50 });
    const notYet = item("merge-failed", { createdAt: 0, nextMergeAttemptAt: 500 });
    const running = item("running", { createdAt: 0 });
    expect(selectMergeCandidates([due, notYet, running, older], 100).map(i => i.id)).toEqual([older.id, due.id]);
  });
});

describe("queue persistence", () => {
  it("enqueue creates pending items, enqueueApproved creates approved ones", () => {
    const a = enqueue(task);
    const b = enqueueApproved(task);
    const queue = loadQueue();
    expect(queue.items.map(i => [i.id, i.status])).toEqual([[a.id, "pending"], [b.id, "approved"]]);
    expect(b.reviewedAt).toBeDefined();
  });

  it("deleteItem refuses running items and removes others", () => {
    const pending = enqueue(task);
    enqueueApproved(task);
    const running = dequeueApproved();
    expect(running?.status).toBe("running");
    expect(deleteItem(running!.id)).toBe(false);
    expect(loadQueue().items.some(i => i.id === running!.id)).toBe(true);
    expect(deleteItem(pending.id)).toBe(true);
    expect(loadQueue().items.some(i => i.id === pending.id)).toBe(false);
    expect(() => deleteItem("si_missing")).toThrow(/not found/);
  });

  it("completeItem/failItem report false for vanished items", () => {
    expect(completeItem("si_missing", { success: true, description: "" })).toBe(false);
    expect(failItem("si_missing", { success: false, description: "" })).toBe(false);
    expect(markMergePending("si_missing", { success: true, description: "", prUrl: "u" })).toBe(false);
  });

  it("markMergePending parks the item; completeItem records mergedAt into history", () => {
    enqueueApproved(task);
    const running = dequeueApproved()!;
    expect(markMergePending(running.id, { success: true, description: "d", prUrl: "https://x/pull/1" })).toBe(true);
    const parked = loadQueue().items[0];
    expect(parked.status).toBe("merge-pending");
    expect(parked.mergeAttempts).toBe(0);
    expect(completeItem(running.id, parked.result!, 12345)).toBe(true);
    expect(loadQueue().items).toHaveLength(0);
    const [entry] = loadHistory().entries;
    expect(entry.status).toBe("completed");
    expect(entry.mergedAt).toBe(12345);
  });

  it("recordMergeFailure increments attempts and schedules the retry", () => {
    enqueueApproved(task);
    const running = dequeueApproved()!;
    markMergePending(running.id, { success: true, description: "d", prUrl: "u" });
    const first = recordMergeFailure(running.id, "tsc failed", 999);
    expect(first?.status).toBe("merge-failed");
    expect(first?.mergeAttempts).toBe(1);
    expect(first?.nextMergeAttemptAt).toBe(999);
    expect(first?.result?.mergeError).toBe("tsc failed");
    const second = recordMergeFailure(running.id, "vitest failed", 1999);
    expect(second?.mergeAttempts).toBe(2);
    expect(recordMergeFailure("si_missing", "x", 1)).toBeNull();
  });
});
