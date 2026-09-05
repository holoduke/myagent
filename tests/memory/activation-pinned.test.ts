import { describe, it, expect, vi } from "vitest";

vi.mock("../../backend/utils/file-store.js", () => ({ safeReadJSON: () => ({}), atomicWriteJSON: () => {}, ensureDir: () => {} }));
vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain", OWNER_NAME: "TestOwner" }));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { selectPinnedForBudget } from "../../backend/memory/activation.js";
import type { MemoryNode } from "../../backend/memory/types.js";
import { PINNED_CONTEXT_SHARE } from "../../backend/memory/types.js";

const pin = (id: string, importance: number | undefined, strength = 0.5): MemoryNode =>
  ({ id, type: "meta", content: id, tags: [], strength, pinned: true, createdAt: 0, lastAccessedAt: 0, accessCount: 0, importance });

describe("selectPinnedForBudget", () => {
  it("returns everything when pinned nodes fit within the share", () => {
    const pins = [pin("a", 0.9), pin("b", 0.1)];
    expect(selectPinnedForBudget(pins, 20)).toEqual(pins);
  });

  it("caps pinned nodes at 30% of the budget, preferring importance then strength", () => {
    const pins = [pin("low", 0.1), pin("hi", 0.9), pin("mid-weak", 0.5, 0.2), pin("mid-strong", 0.5, 0.9), pin("none", undefined), pin("x", 0.3), pin("y", 0.2)];
    const budget = 10;
    const picked = selectPinnedForBudget(pins, budget);
    expect(picked.length).toBe(Math.floor(budget * PINNED_CONTEXT_SHARE));
    expect(picked.map(p => p.id)).toEqual(["hi", "mid-strong", "mid-weak"]);
  });

  it("always keeps at least one pinned node on tiny budgets", () => {
    expect(selectPinnedForBudget([pin("a", 0.2), pin("b", 0.8)], 2).map(p => p.id)).toEqual(["b"]);
    expect(selectPinnedForBudget([], 2)).toEqual([]);
  });
});
