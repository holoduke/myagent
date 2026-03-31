import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { buildContactModel, buildActiveContactModels, getToMSummary, clearContactModelCache } from "../backend/mental-model.js";
import type { MemoryNode } from "../backend/memory/types.js";

beforeEach(() => {
  clearContactModelCache();
});

const now = Date.now();

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test",
    type: "person",
    content: "Alice",
    tags: [],
    strength: 0.8,
    pinned: false,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 5,
    ...overrides,
  };
}

describe("buildContactModel", () => {
  it("returns null for non-existent node", () => {
    const mockGraph = {
      getNode: vi.fn().mockReturnValue(null),
    } as any;

    expect(buildContactModel(mockGraph, "n_missing")).toBeNull();
  });

  it("returns null for non-person node", () => {
    const mockGraph = {
      getNode: vi.fn().mockReturnValue(makeNode({ type: "fact" as any })),
    } as any;

    expect(buildContactModel(mockGraph, "n_test")).toBeNull();
  });

  it("builds a model for a person node", () => {
    const personNode = makeNode({ id: "p1", content: "Alice (friend)" });

    const mockGraph = {
      getNode: vi.fn().mockImplementation((id: string) => {
        if (id === "p1") return personNode;
        if (id === "e1") return makeNode({ id: "e1", type: "event" as any, content: "Alice talked about her project at work", tags: ["work", "project"] });
        return null;
      }),
      edgesFor: vi.fn().mockReturnValue([
        { from: "p1", to: "e1", type: "social", weight: 0.7 },
      ]),
    } as any;

    const model = buildContactModel(mockGraph, "p1");
    expect(model).not.toBeNull();
    expect(model!.name).toBe("Alice (friend)");
    expect(model!.languages).toContain("English");
  });
});

describe("buildActiveContactModels", () => {
  it("builds models for active contacts only", () => {
    const old = Date.now() - 30 * 24 * 3600_000; // 30 days
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "p1", content: "Active Alice", pinned: true }),
        makeNode({ id: "p2", content: "Old Bob", pinned: false, lastAccessedAt: old }),
      ]),
      getNode: vi.fn().mockImplementation((id: string) => {
        if (id === "p1") return makeNode({ id: "p1", content: "Active Alice", pinned: true });
        if (id === "p2") return makeNode({ id: "p2", content: "Old Bob", pinned: false, lastAccessedAt: old });
        return null;
      }),
      edgesFor: vi.fn().mockReturnValue([]),
    } as any;

    const models = buildActiveContactModels(mockGraph);
    // Active Alice (pinned) should be included, Old Bob should be excluded
    expect(models.length).toBe(1);
    expect(models[0].name).toBe("Active Alice");
  });
});

describe("getToMSummary", () => {
  it("returns empty when no active contacts", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getToMSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary for active contacts", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "p1", content: "Alice", pinned: true }),
      ]),
      getNode: vi.fn().mockImplementation((id: string) => {
        if (id === "p1") return makeNode({ id: "p1", content: "Alice", pinned: true });
        if (id === "e1") return makeNode({ id: "e1", type: "event" as any, content: "Chat about cooking", tags: ["cooking", "hobby"] });
        return null;
      }),
      edgesFor: vi.fn().mockReturnValue([
        { from: "p1", to: "e1", type: "social", weight: 0.7 },
      ]),
    } as any;

    const summary = getToMSummary(mockGraph);
    expect(summary).toContain("Alice");
  });
});
