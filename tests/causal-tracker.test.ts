import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
}));

import { detectCausalLinks, recordCausalLinks, traceCausalChain, getCausalContextSummary } from "../backend/causal-tracker.js";

describe("detectCausalLinks", () => {
  it("returns empty for graph with no recent nodes", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
      allEdges: vi.fn().mockReturnValue([]),
    } as any;

    const links = detectCausalLinks(mockGraph);
    expect(links).toEqual([]);
  });

  it("detects links between temporally proximate nodes with shared tags", () => {
    const now = Date.now();
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "event") return [
          { id: "e1", type: "event", content: "Meeting canceled because of rain", tags: ["meeting", "weather"], strength: 0.8, createdAt: now - 3600_000, lastAccessedAt: now, accessCount: 1, pinned: false },
          { id: "e2", type: "event", content: "Rescheduled the meeting for tomorrow", tags: ["meeting", "schedule"], strength: 0.8, createdAt: now - 1800_000, lastAccessedAt: now, accessCount: 1, pinned: false },
        ];
        return [];
      }),
      allEdges: vi.fn().mockReturnValue([]),
    } as any;

    const links = detectCausalLinks(mockGraph);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].causeNodeId).toBe("e1");
    expect(links[0].effectNodeId).toBe("e2");
  });
});

describe("recordCausalLinks", () => {
  it("creates causal edges for valid links", () => {
    const mockGraph = {
      getNode: vi.fn().mockReturnValue({ id: "test" }),
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const links = [{
      causeNodeId: "e1",
      effectNodeId: "e2",
      confidence: 0.6,
      evidence: "temporal proximity",
    }];

    const created = recordCausalLinks(mockGraph, links);
    expect(created).toBe(1);
    expect(mockGraph.applyOperations).toHaveBeenCalledWith([{
      op: "add_edge",
      from: "e1",
      to: "e2",
      type: "causal",
      weight: 0.6,
    }]);
  });

  it("skips links where nodes don't exist", () => {
    const mockGraph = {
      getNode: vi.fn().mockReturnValue(null),
      applyOperations: vi.fn(),
    } as any;

    const links = [{
      causeNodeId: "e1",
      effectNodeId: "e2",
      confidence: 0.6,
      evidence: "test",
    }];

    const created = recordCausalLinks(mockGraph, links);
    expect(created).toBe(0);
  });
});

describe("traceCausalChain", () => {
  it("traces a chain of causal edges", () => {
    const mockGraph = {
      edgesFor: vi.fn().mockImplementation((id: string) => {
        if (id === "a") return [{ from: "a", to: "b", type: "causal", weight: 0.8 }];
        if (id === "b") return [{ from: "b", to: "c", type: "causal", weight: 0.7 }];
        return [];
      }),
      getNode: vi.fn().mockImplementation((id: string) => ({
        id,
        content: `Node ${id}`,
        type: "event",
      })),
    } as any;

    const chains = traceCausalChain(mockGraph, "a");
    expect(chains.length).toBeGreaterThanOrEqual(1);
    expect(chains[0].nodes).toContain("a");
    expect(chains[0].nodes).toContain("c");
  });
});

describe("getCausalContextSummary", () => {
  it("returns empty when no causal edges", () => {
    const mockGraph = {
      allEdges: vi.fn().mockReturnValue([]),
    } as any;

    expect(getCausalContextSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary", () => {
    const now = Date.now();
    const mockGraph = {
      allEdges: vi.fn().mockReturnValue([{
        from: "a",
        to: "b",
        type: "causal",
        weight: 0.7,
        createdAt: now - 3600_000,
        lastReinforcedAt: now,
      }]),
      getNode: vi.fn().mockImplementation((id: string) => ({
        id,
        content: id === "a" ? "Rain started" : "Meeting canceled",
      })),
    } as any;

    const summary = getCausalContextSummary(mockGraph);
    expect(summary).toContain("Rain");
    expect(summary).toContain("Meeting");
  });
});
