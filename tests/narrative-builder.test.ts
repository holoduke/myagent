import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { buildNarrative, getNarrativeSummary } from "../backend/narrative-builder.js";
import type { MemoryNode } from "../backend/memory/types.js";

const now = Date.now();

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test",
    type: "event",
    content: "Test event",
    tags: ["test"],
    strength: 0.5,
    pinned: false,
    createdAt: now - 2 * 24 * 3600_000, // 2 days ago
    lastAccessedAt: now,
    accessCount: 2,
    ...overrides,
  };
}

describe("buildNarrative", () => {
  it("returns empty threads when no recent nodes", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    const narrative = buildNarrative(mockGraph);
    expect(narrative.threads).toEqual([]);
    expect(narrative.overallMood).toBe("neutral");
    expect(narrative.keyThemes).toEqual([]);
  });

  it("clusters related events into threads", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "event") return [
          makeNode({ id: "e1", tags: ["alice", "project", "meeting"], content: "Alice had project meeting" }),
          makeNode({ id: "e2", tags: ["alice", "project", "deadline"], content: "Alice mentioned project deadline" }),
        ];
        if (type === "fact") return [
          makeNode({ id: "f1", tags: ["alice", "project"], content: "Alice leads project X", type: "fact" as any }),
        ];
        if (type === "insight") return [];
        if (type === "emotion") return [];
        return [];
      }),
      edgesFor: vi.fn().mockReturnValue([]),
      getNode: vi.fn().mockReturnValue(null),
    } as any;

    const narrative = buildNarrative(mockGraph);
    expect(narrative.threads.length).toBeGreaterThanOrEqual(1);
    expect(narrative.threads[0].events.length).toBeGreaterThanOrEqual(2);
  });

  it("detects positive mood from emotion nodes", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "emotion") return [
          makeNode({ id: "em1", type: "emotion" as any, emotionalValence: 0.7 }),
          makeNode({ id: "em2", type: "emotion" as any, emotionalValence: 0.5 }),
        ];
        return [];
      }),
    } as any;

    const narrative = buildNarrative(mockGraph);
    expect(narrative.overallMood).toBe("positive");
  });

  it("detects concerned mood from negative emotions", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "emotion") return [
          makeNode({ id: "em1", type: "emotion" as any, emotionalValence: -0.6 }),
          makeNode({ id: "em2", type: "emotion" as any, emotionalValence: -0.4 }),
        ];
        return [];
      }),
    } as any;

    const narrative = buildNarrative(mockGraph);
    expect(narrative.overallMood).toBe("concerned");
  });

  it("extracts key themes from frequent tags", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "event") return [
          makeNode({ id: "e1", tags: ["alice", "project"], content: "Event 1" }),
          makeNode({ id: "e2", tags: ["alice", "budget"], content: "Event 2" }),
          makeNode({ id: "e3", tags: ["alice", "timeline"], content: "Event 3" }),
        ];
        if (type === "emotion") return [];
        return [];
      }),
    } as any;

    const narrative = buildNarrative(mockGraph);
    expect(narrative.keyThemes).toContain("alice");
  });

  it("marks recent threads as ongoing", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "event") return [
          makeNode({ id: "e1", tags: ["alice", "project", "meeting"], createdAt: now - 3600_000 }),
          makeNode({ id: "e2", tags: ["alice", "project", "update"], createdAt: now - 7200_000 }),
        ];
        if (type === "fact") return [
          makeNode({ id: "f1", tags: ["alice", "project"], type: "fact" as any }),
        ];
        if (type === "emotion") return [];
        return [];
      }),
      edgesFor: vi.fn().mockReturnValue([]),
      getNode: vi.fn().mockReturnValue(null),
    } as any;

    const narrative = buildNarrative(mockGraph);
    if (narrative.threads.length > 0) {
      expect(narrative.threads[0].status).toBe("ongoing");
    }
  });
});

describe("getNarrativeSummary", () => {
  it("returns empty string when no threads", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getNarrativeSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary with threads", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "event") return [
          makeNode({ id: "e1", tags: ["alice", "project", "meeting"], content: "Alice meeting" }),
          makeNode({ id: "e2", tags: ["alice", "project", "update"], content: "Alice update" }),
        ];
        if (type === "fact") return [
          makeNode({ id: "f1", tags: ["alice", "project"], type: "fact" as any, content: "Alice on project X" }),
        ];
        if (type === "emotion") return [];
        return [];
      }),
      edgesFor: vi.fn().mockReturnValue([]),
      getNode: vi.fn().mockReturnValue(null),
    } as any;

    const summary = getNarrativeSummary(mockGraph);
    expect(summary).toContain("Mood:");
    expect(summary).toContain("Themes:");
  });
});
