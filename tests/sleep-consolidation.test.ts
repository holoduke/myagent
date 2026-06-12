import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
  getNodeEmbedding: vi.fn().mockReturnValue(null),
}));

import { detectConflicts, resolveConflicts, promoteEpisodicToSemantic, runSleepConsolidation } from "../backend/sleep-consolidation.js";
import type { MemoryNode } from "../backend/memory/types.js";

const now = Date.now();

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test",
    type: "fact",
    content: "Test fact content",
    tags: ["test"],
    strength: 0.7,
    pinned: false,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 3,
    ...overrides,
  };
}

describe("detectConflicts", () => {
  it("returns empty for graph with no facts", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
      allEdges: vi.fn().mockReturnValue([]),
      edgesFor: vi.fn().mockReturnValue([]),
    } as any;

    expect(detectConflicts(mockGraph)).toEqual([]);
  });

  it("detects near-duplicate nodes", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "fact") return [
          makeNode({ id: "f1", content: "Lucas is eight years old and goes to school", tags: ["lucas", "age"] }),
          makeNode({ id: "f2", content: "Lucas is eight years old and he goes to school daily", tags: ["lucas", "age", "school"] }),
        ];
        return [];
      }),
      allEdges: vi.fn().mockReturnValue([]),
      edgesFor: vi.fn().mockReturnValue([]),
    } as any;

    const conflicts = detectConflicts(mockGraph);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].conflictType).toBe("near-duplicate");
  });

  it("detects contradictions via edges", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "fact") return [
          makeNode({ id: "f1", content: "Lucas prefers football", tags: ["lucas", "sport"] }),
          makeNode({ id: "f2", content: "Lucas dislikes football", tags: ["lucas", "sport"] }),
        ];
        return [];
      }),
      allEdges: vi.fn().mockReturnValue([]),
      edgesFor: vi.fn().mockImplementation((id: string) => {
        if (id === "f1") return [{ from: "f1", to: "f2", type: "contradicts", weight: 0.8 }];
        return [];
      }),
    } as any;

    const conflicts = detectConflicts(mockGraph);
    expect(conflicts.some(c => c.conflictType === "contradiction")).toBe(true);
  });
});

describe("resolveConflicts", () => {
  it("merges near-duplicate nodes", () => {
    const mockGraph = {
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const pairs = [{
      nodeA: makeNode({ id: "f1", strength: 0.8 }),
      nodeB: makeNode({ id: "f2", strength: 0.4 }),
      conflictType: "near-duplicate" as const,
      similarity: 0.85,
    }];

    const resolved = resolveConflicts(mockGraph, pairs);
    expect(resolved).toBe(1);
    expect(mockGraph.applyOperations).toHaveBeenCalled();
  });

  it("weakens contradicted nodes", () => {
    const mockGraph = {
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const pairs = [{
      nodeA: makeNode({ id: "f1", strength: 0.3 }),
      nodeB: makeNode({ id: "f2", strength: 0.7 }),
      conflictType: "contradiction" as const,
      similarity: 0.4,
    }];

    const resolved = resolveConflicts(mockGraph, pairs);
    expect(resolved).toBe(1);
    // Should weaken f1 (the weaker node)
    const call = mockGraph.applyOperations.mock.calls[0][0][0];
    expect(call.op).toBe("weaken");
    expect(call.id).toBe("f1");
  });
});

describe("promoteEpisodicToSemantic", () => {
  it("promotes frequently-accessed old events", () => {
    const old = Date.now() - 14 * 24 * 3600_000; // 14 days ago
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "e1", type: "event" as any, accessCount: 15, createdAt: old, lastAccessedAt: now, strength: 0.6, tags: ["meeting"] }),
      ]),
      updateNode: vi.fn(),
      getNode: vi.fn().mockReturnValue(makeNode({ id: "e1", type: "event" as any, accessCount: 15, strength: 0.6, tags: ["meeting"] })),
    } as any;

    const promoted = promoteEpisodicToSemantic(mockGraph);
    expect(promoted).toBe(1);
    expect(mockGraph.updateNode).toHaveBeenCalled();
  });

  it("skips already-promoted events", () => {
    const old = Date.now() - 14 * 24 * 3600_000;
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "e1", type: "event" as any, accessCount: 15, createdAt: old, strength: 0.6, tags: ["meeting", "promoted-to-semantic"] }),
      ]),
    } as any;

    const promoted = promoteEpisodicToSemantic(mockGraph);
    expect(promoted).toBe(0);
  });
});

describe("runSleepConsolidation", () => {
  it("returns consolidation result", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
      allEdges: vi.fn().mockReturnValue([]),
      edgesFor: vi.fn().mockReturnValue([]),
    } as any;

    const result = runSleepConsolidation(mockGraph);
    expect(result.conflictsDetected).toBe(0);
    expect(result.conflictsResolved).toBe(0);
    expect(result.promotedToSemantic).toBe(0);
  });
});
