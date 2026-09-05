import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
}));

import {
  findConsolidationCandidates,
  createGistNode,
  buildGistSummary,
  runReflectiveConsolidation,
  isConsolidationExempt,
} from "../backend/reflective-consolidation.js";
import type { MemoryNode } from "../backend/memory/types.js";

const now = Date.now();
const OLD = now - 10 * 24 * 3600_000; // 10 days old

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test",
    type: "fact",
    content: "Test fact content",
    tags: ["test"],
    strength: 0.2,
    pinned: false,
    createdAt: OLD,
    lastAccessedAt: OLD,
    accessCount: 1,
    ...overrides,
  };
}

describe("findConsolidationCandidates", () => {
  it("returns empty for graph with no weak nodes", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([]),
    } as any;

    const result = findConsolidationCandidates(mockGraph);
    expect(result).toEqual([]);
  });

  it("returns empty when nodes are too strong", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([
        makeNode({ id: "n1", strength: 0.8, tags: ["alice", "work"] }),
        makeNode({ id: "n2", strength: 0.9, tags: ["alice", "work"] }),
        makeNode({ id: "n3", strength: 0.7, tags: ["alice", "work"] }),
      ]),
    } as any;

    const result = findConsolidationCandidates(mockGraph);
    expect(result).toEqual([]);
  });

  it("finds clusters of weak nodes sharing 2+ tags", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([
        makeNode({ id: "n1", tags: ["alice", "project", "work"], strength: 0.15 }),
        makeNode({ id: "n2", tags: ["alice", "project", "meeting"], strength: 0.1 }),
        makeNode({ id: "n3", tags: ["alice", "project", "deadline"], strength: 0.2 }),
      ]),
    } as any;

    const result = findConsolidationCandidates(mockGraph);
    expect(result.length).toBe(1);
    expect(result[0].nodes.length).toBe(3);
    expect(result[0].sharedTags).toContain("alice");
    expect(result[0].sharedTags).toContain("project");
  });

  it("skips pinned nodes", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([
        makeNode({ id: "n1", tags: ["alice", "project"], strength: 0.15, pinned: true }),
        makeNode({ id: "n2", tags: ["alice", "project"], strength: 0.1 }),
        makeNode({ id: "n3", tags: ["alice", "project"], strength: 0.2 }),
      ]),
    } as any;

    const result = findConsolidationCandidates(mockGraph);
    // Cluster needs 3 non-pinned; we only have 2 non-pinned
    expect(result).toEqual([]);
  });

  it("skips nodes that are too recent", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([
        makeNode({ id: "n1", tags: ["alice", "project"], strength: 0.15, createdAt: now - 3600_000 }),
        makeNode({ id: "n2", tags: ["alice", "project"], strength: 0.1, createdAt: now - 3600_000 }),
        makeNode({ id: "n3", tags: ["alice", "project"], strength: 0.2, createdAt: now - 3600_000 }),
      ]),
    } as any;

    const result = findConsolidationCandidates(mockGraph);
    expect(result).toEqual([]);
  });
});

describe("buildGistSummary", () => {
  it("builds summary from candidate cluster", () => {
    const candidate = {
      nodes: [
        makeNode({ id: "n1", type: "event" as any, content: "Alice had a meeting about project X. It went well.", tags: ["alice", "project"] }),
        makeNode({ id: "n2", type: "event" as any, content: "Alice mentioned deadline for project X is Friday.", tags: ["alice", "project"] }),
        makeNode({ id: "n3", type: "event" as any, content: "Alice asked about project X budget allocation.", tags: ["alice", "project"] }),
      ],
      sharedTags: ["alice", "project"],
      averageStrength: 0.15,
      totalContent: "",
    };

    const summary = buildGistSummary(candidate);
    expect(summary).toContain("3");
    expect(summary).toContain("event");
    expect(summary).toContain("alice");
    expect(summary).toContain("project");
  });
});

function mockWritableGraph(nodes: MemoryNode[]) {
  const ops: any[] = [];
  const updates: { id: string; tags?: string[] }[] = [];
  const archived: { id: string; reason: string }[] = [];
  return {
    ops,
    updates,
    archived,
    graph: {
      allNodes: vi.fn().mockReturnValue(nodes),
      applyOperations: vi.fn().mockImplementation((o: any) => {
        ops.push(...o);
        return { applied: o.length, skipped: 0, dropped: 0 };
      }),
      updateNode: vi.fn().mockImplementation((id: string, u: { tags?: string[] }) => { updates.push({ id, ...u }); }),
      archiveNode: vi.fn().mockImplementation((id: string, reason: string) => { archived.push({ id, reason }); return true; }),
    } as any,
  };
}

describe("createGistNode", () => {
  it("creates gist node, tags originals with the gist id and archives them", () => {
    const nodes = [
      makeNode({ id: "n1", type: "event" as any, tags: ["alice", "project"] }),
      makeNode({ id: "n2", type: "event" as any, tags: ["alice", "project"] }),
      makeNode({ id: "n3", type: "event" as any, tags: ["alice", "project"] }),
    ];
    const { graph, ops, updates, archived } = mockWritableGraph(nodes);

    const candidate = {
      nodes,
      sharedTags: ["alice", "project"],
      averageStrength: 0.15,
      totalContent: "combined text",
    };

    const result = createGistNode(graph, candidate, "Test summary");
    expect(result.nodesConsolidated).toBe(3);
    expect(result.summary).toBe("Test summary");

    const addOps = ops.filter((o: any) => o.op === "add_node");
    expect(addOps.length).toBe(1);
    expect(addOps[0].type).toBe("insight"); // events distil into an insight
    expect(addOps[0].content).toContain("[gist]");
    expect(addOps[0].tags).toContain("gist");
    expect(addOps[0].tags).toContain("reflective-consolidation");

    expect(updates.map(u => u.id).sort()).toEqual(["n1", "n2", "n3"]);
    for (const u of updates) {
      expect(u.tags).toContain(`consolidated:${result.gistNodeId}`);
      expect(u.tags).toContain("alice"); // original tags preserved
    }
    expect(archived).toEqual([
      { id: "n1", reason: "consolidation" },
      { id: "n2", reason: "consolidation" },
      { id: "n3", reason: "consolidation" },
    ]);
    expect(ops.some((o: any) => o.op === "weaken" || o.op === "remove_node")).toBe(false);
  });
});

describe("consolidation exemptions", () => {
  it("never clusters gist nodes or already-consolidated nodes", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([
        makeNode({ id: "g1", tags: ["alice", "project", "gist"], strength: 0.1 }),
        makeNode({ id: "c1", tags: ["alice", "project", "consolidated:gist_abc"], strength: 0.1 }),
        makeNode({ id: "n1", tags: ["alice", "project"], strength: 0.1 }),
        makeNode({ id: "n2", tags: ["alice", "project"], strength: 0.1 }),
      ]),
    } as any;
    // Only n1 + n2 are eligible — below the cluster minimum of 3
    expect(findConsolidationCandidates(mockGraph)).toEqual([]);
    expect(isConsolidationExempt(makeNode({ tags: ["Gist"] }))).toBe(true);
    expect(isConsolidationExempt(makeNode({ tags: ["consolidated:x"] }))).toBe(true);
    expect(isConsolidationExempt(makeNode({ tags: ["work"] }))).toBe(false);
  });
});

describe("runReflectiveConsolidation", () => {
  it("returns empty when no candidates found", () => {
    const mockGraph = {
      allNodes: vi.fn().mockReturnValue([]),
    } as any;

    const results = runReflectiveConsolidation(mockGraph);
    expect(results).toEqual([]);
  });

  it("creates gist nodes for found clusters", () => {
    const { graph, archived } = mockWritableGraph([
      makeNode({ id: "n1", tags: ["alice", "project", "work"], strength: 0.15 }),
      makeNode({ id: "n2", tags: ["alice", "project", "meeting"], strength: 0.1 }),
      makeNode({ id: "n3", tags: ["alice", "project", "deadline"], strength: 0.2 }),
    ]);

    const results = runReflectiveConsolidation(graph);
    expect(results.length).toBe(1);
    expect(results[0].nodesConsolidated).toBe(3);
    expect(results[0].summary).toContain("alice");
    expect(archived.length).toBe(3);
  });
});
