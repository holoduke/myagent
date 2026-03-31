import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
}));

import { getBeliefs, getBeliefSummary, updateBeliefConfidence, detectStaleBeliefs } from "../backend/belief-tracker.js";

describe("getBeliefs", () => {
  it("returns belief nodes from graph", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        { id: "b1", type: "belief", content: "Lucas likes football", confidence: 0.8, tags: [], strength: 0.7, pinned: false, createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 1 },
      ]),
    } as any;

    const beliefs = getBeliefs(mockGraph);
    expect(beliefs.length).toBe(1);
    expect(mockGraph.findByType).toHaveBeenCalledWith("belief");
  });
});

describe("getBeliefSummary", () => {
  it("returns empty for no beliefs", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getBeliefSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary sorted by confidence", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        { id: "b1", type: "belief", content: "Low confidence belief", confidence: 0.3, tags: [], strength: 0.5, pinned: false, createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 1 },
        { id: "b2", type: "belief", content: "High confidence belief", confidence: 0.9, tags: [], strength: 0.8, pinned: false, createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 1 },
      ]),
    } as any;

    const summary = getBeliefSummary(mockGraph);
    expect(summary).toContain("high");
    expect(summary).toContain("low");
    // High confidence should come first
    expect(summary.indexOf("High")).toBeLessThan(summary.indexOf("Low"));
  });
});

describe("updateBeliefConfidence", () => {
  it("strengthens belief confidence", () => {
    const belief = {
      id: "b1", type: "belief", content: "Test belief", confidence: 0.5,
      tags: [], strength: 0.7, pinned: false, createdAt: Date.now(),
      lastAccessedAt: Date.now(), accessCount: 1,
    };

    const mockGraph = {
      getNode: vi.fn().mockReturnValue({ ...belief }),
      updateNode: vi.fn(),
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const updated = updateBeliefConfidence(mockGraph, [{
      nodeId: "b1",
      direction: "strengthen",
      evidence: "Owner confirmed this is true",
      confidenceDelta: 0.2,
    }]);

    expect(updated).toBe(1);
  });

  it("weakens belief and adds disputed tag below threshold", () => {
    const belief = {
      id: "b1", type: "belief", content: "Test belief", confidence: 0.3,
      tags: [], strength: 0.7, pinned: false, createdAt: Date.now(),
      lastAccessedAt: Date.now(), accessCount: 1,
    };

    const mockGraph = {
      getNode: vi.fn().mockReturnValue({ ...belief }),
      updateNode: vi.fn(),
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const updated = updateBeliefConfidence(mockGraph, [{
      nodeId: "b1",
      direction: "contradict",
      evidence: "New evidence contradicts this",
      confidenceDelta: -0.2,
    }]);

    expect(updated).toBe(1);
    // Should have created a meta node for the contradiction
    expect(mockGraph.applyOperations).toHaveBeenCalled();
  });

  it("skips non-belief nodes", () => {
    const mockGraph = {
      getNode: vi.fn().mockReturnValue({ id: "f1", type: "fact" }),
      updateNode: vi.fn(),
    } as any;

    const updated = updateBeliefConfidence(mockGraph, [{
      nodeId: "f1",
      direction: "strengthen",
      evidence: "test",
      confidenceDelta: 0.1,
    }]);

    expect(updated).toBe(0);
  });
});

describe("detectStaleBeliefs", () => {
  it("returns empty when all beliefs are fresh", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        { id: "b1", type: "belief", content: "Fresh belief", confidence: 0.8, tags: [], strength: 0.7, pinned: false, createdAt: Date.now(), lastAccessedAt: Date.now(), accessCount: 1 },
      ]),
      edgesFor: vi.fn().mockReturnValue([]),
    } as any;

    const stale = detectStaleBeliefs(mockGraph);
    expect(stale.length).toBe(0);
  });

  it("detects old beliefs with medium confidence", () => {
    const old = Date.now() - 45 * 24 * 3600_000; // 45 days ago
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        { id: "b1", type: "belief", content: "Old belief", confidence: 0.5, tags: [], strength: 0.5, pinned: false, createdAt: old, lastAccessedAt: old, accessCount: 3 },
      ]),
      edgesFor: vi.fn().mockReturnValue([]),
    } as any;

    const stale = detectStaleBeliefs(mockGraph);
    expect(stale.length).toBe(1);
  });
});
