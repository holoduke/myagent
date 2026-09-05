import { describe, it, expect, vi } from "vitest";

vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain" }));
vi.mock("../../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));
vi.mock("../../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC" }),
  getOwnerLocalTime: (_tz: string, now: Date) => ({ hour: now.getUTCHours(), dayOfWeek: now.getUTCDay() }),
  getOwnerLocalDate: (_tz: string, now: Date) => now.toISOString().slice(0, 10),
}));

import { mergePendingFollowUps, updateWorkingMemory, compareThreadsForRetention } from "../../backend/memory/working-memory.js";
import type { PendingFollowUp, ConversationThread, WorkingMemory } from "../../backend/memory/types.js";
import { MAX_PENDING_FOLLOWUPS } from "../../backend/memory/types.js";

const fu = (id: string, question: string, extra: Partial<PendingFollowUp> = {}): PendingFollowUp =>
  ({ id, question, context: "", createdAt: 1000, ...extra });

describe("mergePendingFollowUps", () => {
  it("keeps items the brain omitted", () => {
    const merged = mergePendingFollowUps([fu("a", "Ask Alice"), fu("b", "Ask Bob")], [fu("b", "Ask Bob about golf")]);
    expect(merged.map(f => f.id).sort()).toEqual(["a", "b"]);
    expect(merged.find(f => f.id === "b")!.question).toBe("Ask Bob about golf");
  });

  it("drops an item only when explicitly resolved", () => {
    const merged = mergePendingFollowUps([fu("a", "Ask Alice"), fu("b", "Ask Bob")], [fu("a", "Ask Alice", { resolved: true })]);
    expect(merged.map(f => f.id)).toEqual(["b"]);
  });

  it("matches re-emitted items by question text when the id is new, preserving id and createdAt", () => {
    const merged = mergePendingFollowUps([fu("a", "Ask Alice about the trip")], [fu("fresh", "  ask alice about   the trip", { createdAt: 9999, targetPerson: "Alice" })]);
    expect(merged.length).toBe(1);
    expect(merged[0]).toMatchObject({ id: "a", createdAt: 1000, targetPerson: "Alice" });
  });

  it("resolving by question text works without the id", () => {
    const merged = mergePendingFollowUps([fu("a", "Ask Alice")], [fu("other", "Ask Alice", { resolved: true })]);
    expect(merged).toEqual([]);
  });

  it("caps at MAX_PENDING_FOLLOWUPS, dropping the oldest", () => {
    const existing = Array.from({ length: MAX_PENDING_FOLLOWUPS }, (_, i) => fu(`e${i}`, `q${i}`, { createdAt: i }));
    const merged = mergePendingFollowUps(existing, [fu("new", "brand new", { createdAt: 10_000 })]);
    expect(merged.length).toBe(MAX_PENDING_FOLLOWUPS);
    expect(merged.some(f => f.id === "new")).toBe(true);
    expect(merged.some(f => f.id === "e0")).toBe(false);
  });

  it("is wired into updateWorkingMemory", () => {
    const wm = { pendingFollowUps: [fu("a", "Ask Alice")], shortTermTracking: [], activatedNodeIds: [], conversationThreads: [] } as unknown as WorkingMemory;
    updateWorkingMemory(wm, { pendingFollowUps: [fu("b", "Ask Bob")] });
    expect(wm.pendingFollowUps.map(f => f.id).sort()).toEqual(["a", "b"]);
  });
});

describe("compareThreadsForRetention", () => {
  const t = (id: string, status: ConversationThread["status"], lastMessageAt: number): ConversationThread =>
    ({ id, status, lastMessageAt, participants: [], topic: "", messageCount: 1 });

  it("is antisymmetric and orders open-newest-first, closed last", () => {
    const threads = [t("c-old", "closed", 1), t("a-new", "active", 9), t("s-mid", "stale", 5), t("c-new", "closed", 8)];
    for (const a of threads) for (const b of threads) {
      expect(Math.sign(compareThreadsForRetention(a, b)) + Math.sign(compareThreadsForRetention(b, a))).toBe(0);
    }
    expect([...threads].sort(compareThreadsForRetention).map(x => x.id)).toEqual(["a-new", "s-mid", "c-new", "c-old"]);
  });
});
