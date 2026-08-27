import { describe, it, expect } from "vitest";
import { countCompletedOnDay } from "../backend/self-improve-queue.js";
import type { QueueItem } from "../backend/self-improve-queue.js";

const localDateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function item(status: QueueItem["status"], completedAt?: number): QueueItem {
  return {
    id: `q_${Math.random().toString(36).slice(2, 8)}`,
    task: { type: "improvement", description: "x", rationale: "", files: [], memoryContext: [], planNodeId: "", createdAt: 0 },
    status,
    createdAt: 0,
    completedAt,
  };
}

describe("countCompletedOnDay", () => {
  const today = "2026-08-28";
  const todayMs = new Date("2026-08-28T10:00:00Z").getTime();
  const yesterdayMs = new Date("2026-08-27T10:00:00Z").getTime();

  it("counts only completed items from the given day", () => {
    const entries = [
      item("completed", todayMs),
      item("completed", todayMs + 1000),
      item("completed", yesterdayMs),
      item("failed", todayMs),
      item("completed", undefined),
    ];
    expect(countCompletedOnDay(entries, localDateOf, today)).toBe(2);
  });

  it("returns 0 for empty history", () => {
    expect(countCompletedOnDay([], localDateOf, today)).toBe(0);
  });
});
