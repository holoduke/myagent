import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
}));

import {
  detectRepeatedPatterns,
  compilePattern,
  runKnowledgeCompilation,
  getCompiledKnowledgeSummary,
} from "../backend/knowledge-compiler.js";
import type { MemoryNode } from "../backend/memory/types.js";

const now = Date.now();

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test",
    type: "insight",
    content: "Test insight",
    tags: ["test"],
    strength: 0.7,
    pinned: false,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 3,
    ...overrides,
  };
}

describe("detectRepeatedPatterns", () => {
  it("returns empty for graph with no insights", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(detectRepeatedPatterns(mockGraph)).toEqual([]);
  });

  it("returns empty when no pattern meets threshold", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "insight") return [
          makeNode({ id: "i1", tags: ["alice", "schedule"] }),
          makeNode({ id: "i2", tags: ["bob", "finance"] }),
        ];
        return [];
      }),
    } as any;

    expect(detectRepeatedPatterns(mockGraph)).toEqual([]);
  });

  it("detects patterns with 3+ occurrences", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "insight") return [
          makeNode({ id: "i1", tags: ["alice", "schedule"], content: "Alice meeting Monday", confidence: 0.8 }),
          makeNode({ id: "i2", tags: ["alice", "schedule"], content: "Alice meeting Wednesday", confidence: 0.7, createdAt: now - 1000 }),
          makeNode({ id: "i3", tags: ["alice", "schedule"], content: "Alice meeting Friday", confidence: 0.9, createdAt: now - 2000 }),
        ];
        if (type === "procedure") return [];
        return [];
      }),
      getNode: vi.fn().mockImplementation((id: string) => {
        if (id === "i1") return makeNode({ id: "i1", createdAt: now });
        return null;
      }),
    } as any;

    const patterns = detectRepeatedPatterns(mockGraph);
    expect(patterns.length).toBe(1);
    expect(patterns[0].occurrences).toBe(3);
    expect(patterns[0].contextSignature).toContain("alice");
    expect(patterns[0].contextSignature).toContain("schedule");
  });

  it("filters out meta tags like gist and promoted-to-semantic", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "insight") return [
          makeNode({ id: "i1", tags: ["gist", "reflective-consolidation", "topic1"], content: "Summary A" }),
          makeNode({ id: "i2", tags: ["gist", "reflective-consolidation", "topic2"], content: "Summary B" }),
          makeNode({ id: "i3", tags: ["gist", "reflective-consolidation", "topic3"], content: "Summary C" }),
        ];
        if (type === "procedure") return [];
        return [];
      }),
    } as any;

    // After filtering meta tags, each node only has 1 significant tag → skip
    const patterns = detectRepeatedPatterns(mockGraph);
    expect(patterns).toEqual([]);
  });
});

describe("compilePattern", () => {
  it("creates compiled knowledge procedure node", () => {
    const ops: any[] = [];
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
      getNode: vi.fn().mockReturnValue(makeNode()),
      applyOperations: vi.fn().mockImplementation((o: any) => {
        ops.push(...o);
        return { applied: o.length, skipped: 0 };
      }),
    } as any;

    const pattern = {
      contextSignature: "alice|schedule",
      conclusion: "Alice has regular meetings on weekdays",
      occurrences: 5,
      sourceNodeIds: ["i1", "i2", "i3"],
      avgConfidence: 0.8,
    };

    const nodeId = compilePattern(mockGraph, pattern);
    expect(nodeId).not.toBeNull();

    const addOp = ops.find((o: any) => o.op === "add_node");
    expect(addOp).toBeDefined();
    expect(addOp.type).toBe("procedure");
    expect(addOp.tags).toContain("compiled-knowledge");
    expect(addOp.content).toContain("[compiled knowledge]");
  });

  it("skips already compiled patterns", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "p1", type: "procedure" as any, tags: ["compiled-knowledge", "alice|schedule"] }),
      ]),
      applyOperations: vi.fn(),
    } as any;

    const pattern = {
      contextSignature: "alice|schedule",
      conclusion: "Alice meetings",
      occurrences: 3,
      sourceNodeIds: ["i1"],
      avgConfidence: 0.7,
    };

    const nodeId = compilePattern(mockGraph, pattern);
    expect(nodeId).toBeNull();
    expect(mockGraph.applyOperations).not.toHaveBeenCalled();
  });
});

describe("runKnowledgeCompilation", () => {
  it("returns 0 when no patterns found", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(runKnowledgeCompilation(mockGraph)).toBe(0);
  });

  it("compiles detected patterns", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "insight") return [
          makeNode({ id: "i1", tags: ["alice", "schedule"], confidence: 0.8 }),
          makeNode({ id: "i2", tags: ["alice", "schedule"], confidence: 0.7, createdAt: now - 1000 }),
          makeNode({ id: "i3", tags: ["alice", "schedule"], confidence: 0.9, createdAt: now - 2000 }),
        ];
        if (type === "procedure") return [];
        return [];
      }),
      getNode: vi.fn().mockReturnValue(makeNode({ createdAt: now })),
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const compiled = runKnowledgeCompilation(mockGraph);
    expect(compiled).toBe(1);
  });
});

describe("getCompiledKnowledgeSummary", () => {
  it("returns empty string when no compiled knowledge", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getCompiledKnowledgeSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary of compiled knowledge", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({
          id: "p1",
          type: "procedure" as any,
          tags: ["compiled-knowledge", "alice|schedule"],
          content: "[compiled knowledge] When context involves [alice, schedule]: Alice has regular meetings",
          strength: 0.8,
        }),
      ]),
    } as any;

    const summary = getCompiledKnowledgeSummary(mockGraph);
    expect(summary).toContain("alice");
    expect(summary).toContain("schedule");
    expect(summary).not.toContain("[compiled knowledge]");
  });
});
