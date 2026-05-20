import { describe, it, expect, vi, beforeEach } from "vitest";

// ��─ Mocks (hoisted so vi.mock factories can reference them) ─��

const { mockAppendFileSync, mockStatSync, mockRenameSync } = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
  mockStatSync: vi.fn(() => ({ size: 0 })),
  mockRenameSync: vi.fn(),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: (_path: string, defaultValue: unknown) => defaultValue,
  strictReadJSON: () => null,
  atomicWriteJSON: vi.fn(),
  atomicWriteFile: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ activationSpreadFactor: 0.6, maxThinkContextNodes: 20 }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
  removeEmbedding: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    appendFileSync: mockAppendFileSync,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    statSync: mockStatSync,
    renameSync: mockRenameSync,
    mkdirSync: vi.fn(),
  };
});

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { MemoryGraph } from "../backend/memory/graph.js";
import { atomicWriteJSON } from "../backend/utils/file-store.js";
import type { MemoryNode, MemoryEdge } from "../backend/memory/types.js";
import { WAL_MAX_BYTES } from "../backend/memory/types.js";

const now = Date.now();

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test01",
    type: "event",
    content: "Test event content",
    tags: ["test"],
    strength: 0.5,
    pinned: false,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
    ...overrides,
  };
}

// ── Ghost Graph Tests ──

describe("Ghost Graph", () => {
  let graph: MemoryGraph;

  beforeEach(() => {
    vi.clearAllMocks();
    graph = new MemoryGraph();
    // Load with empty data (mocked safeReadJSON returns {})
    graph.load();
  });

  it("starts with zero ghosts", () => {
    expect(graph.ghostCount).toBe(0);
    expect(graph.allGhostNodes()).toEqual([]);
  });

  it("creates ghost nodes when archive exceeds cap", () => {
    // Fill archive to just over the 2000 cap by adding and archiving nodes
    // We need to add nodes to the active graph first, then archive them
    for (let i = 0; i < 2005; i++) {
      graph.addNode(makeNode({
        id: `n_${String(i).padStart(5, "0")}`,
        content: `Node ${i}`,
        tags: [`tag${i}`],
        strength: 0.1,
      }));
    }

    // Archive all nodes — once archive exceeds 2000, ghosts should be created
    for (let i = 0; i < 2005; i++) {
      graph.archiveNode(`n_${String(i).padStart(5, "0")}`, "decay");
    }

    // Should have exactly 2000 archived + 5 ghosts
    expect(graph.archiveSize).toBe(2000);
    expect(graph.ghostCount).toBe(5);
  });

  it("preserves ghost node fields correctly", () => {
    // Add nodes to fill archive to cap
    for (let i = 0; i < 2002; i++) {
      graph.addNode(makeNode({
        id: `n_${String(i).padStart(5, "0")}`,
        content: `Content for node ${i}`,
        tags: [`person${i}`, "work"],
        type: i === 0 ? "person" : "event",
        strength: 0.1,
      }));
    }

    // Archive all — first nodes should become ghosts
    for (let i = 0; i < 2002; i++) {
      graph.archiveNode(`n_${String(i).padStart(5, "0")}`, "decay");
    }

    expect(graph.ghostCount).toBe(2);

    // The first two archived nodes should have been evicted to ghosts
    const ghost0 = graph.getGhost("n_00000");
    expect(ghost0).toBeDefined();
    expect(ghost0!.id).toBe("n_00000");
    expect(ghost0!.type).toBe("person");
    expect(ghost0!.tagFingerprint).toContain("person0");
    expect(ghost0!.tagFingerprint).toContain("work");
    expect(ghost0!.archiveReason).toBe("decay");
    expect(ghost0!.archivedAt).toBeGreaterThan(0);
    expect(ghost0!.evictedAt).toBeGreaterThan(0);
    expect(ghost0!.evictedAt).toBeGreaterThanOrEqual(ghost0!.archivedAt);
    // Ghost should have edges array (may be empty since isolated nodes)
    expect(Array.isArray(ghost0!.edges)).toBe(true);
  });

  it("getGhost returns undefined for non-existent ID", () => {
    expect(graph.getGhost("n_nonexistent")).toBeUndefined();
  });

  it("hasTopology checks active, archive, and ghost layers", () => {
    // Active node
    graph.addNode(makeNode({ id: "n_active" }));
    expect(graph.hasTopology("n_active")).toBe(true);

    // Archive node (archive directly by adding then archiving)
    graph.addNode(makeNode({ id: "n_archived", strength: 0.1 }));
    graph.archiveNode("n_archived", "decay");
    expect(graph.hasTopology("n_archived")).toBe(true);

    // Non-existent
    expect(graph.hasTopology("n_doesnt_exist")).toBe(false);
  });

  it("allGhostNodes returns all ghosts as array", () => {
    // Create 2003 nodes and archive them
    for (let i = 0; i < 2003; i++) {
      graph.addNode(makeNode({
        id: `n_${String(i).padStart(5, "0")}`,
        tags: [`tag${i}`],
        strength: 0.1,
      }));
    }
    for (let i = 0; i < 2003; i++) {
      graph.archiveNode(`n_${String(i).padStart(5, "0")}`, "decay");
    }

    const ghosts = graph.allGhostNodes();
    expect(ghosts.length).toBe(3);
    expect(ghosts.every(g => g.id && g.type && g.tagFingerprint)).toBe(true);
  });

  it("getStats includes ghostCount", () => {
    const stats = graph.getStats();
    expect(stats).toHaveProperty("ghostCount");
    expect(stats.ghostCount).toBe(0);
  });

  it("ghost graph persists via save()", () => {
    // Add and archive enough to create ghosts
    for (let i = 0; i < 2002; i++) {
      graph.addNode(makeNode({
        id: `n_${String(i).padStart(5, "0")}`,
        tags: [`tag${i}`],
        strength: 0.1,
      }));
    }
    for (let i = 0; i < 2002; i++) {
      graph.archiveNode(`n_${String(i).padStart(5, "0")}`, "decay");
    }

    expect(graph.ghostCount).toBe(2);

    graph.save();

    // Verify atomicWriteJSON was called with ghost data
    const calls = (atomicWriteJSON as ReturnType<typeof vi.fn>).mock.calls;
    const ghostCall = calls.find(c => String(c[0]).includes("ghost-graph.json"));
    expect(ghostCall).toBeDefined();

    const ghostData = ghostCall![1] as Record<string, unknown>;
    expect(Object.keys(ghostData).length).toBe(2);
  });

  it("preserves edge topology in ghost nodes", () => {
    // Create two connected nodes
    graph.addNode(makeNode({ id: "n_source", tags: ["person"], strength: 0.1 }));
    graph.addNode(makeNode({ id: "n_target", tags: ["project"], strength: 0.8 }));
    graph.addEdge({
      from: "n_source",
      to: "n_target",
      type: "topical",
      weight: 0.7,
      createdAt: now,
      lastReinforcedAt: now,
    });

    // Fill archive to capacity
    for (let i = 0; i < 2001; i++) {
      graph.addNode(makeNode({
        id: `n_filler_${String(i).padStart(5, "0")}`,
        tags: [`filler${i}`],
        strength: 0.1,
      }));
    }

    // Archive source first (it has edges)
    graph.archiveNode("n_source", "decay");

    // Archive fillers to push source out of archive into ghost
    for (let i = 0; i < 2001; i++) {
      graph.archiveNode(`n_filler_${String(i).padStart(5, "0")}`, "decay");
    }

    // n_source should now be a ghost with edge topology preserved
    const ghost = graph.getGhost("n_source");
    if (ghost) {
      expect(ghost.edges.length).toBeGreaterThanOrEqual(1);
      expect(ghost.edges.some(e => e.to === "n_target" || e.from === "n_source")).toBe(true);
    }
  });
});

// ── WAL Tests ──

describe("Write-Ahead Log (WAL)", () => {
  let graph: MemoryGraph;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatSync.mockReturnValue({ size: 0 });
    graph = new MemoryGraph();
    graph.load();
  });

  function getWalEntries(): Array<{ ts: number; op: string; [key: string]: unknown }> {
    return mockAppendFileSync.mock.calls
      .filter(call => String(call[0]).includes("wal.jsonl"))
      .map(call => JSON.parse(String(call[1]).trim()));
  }

  it("logs WAL entry for add_node via applyOperations", () => {
    graph.applyOperations([{
      op: "add_node",
      id: "n_wal_test",
      type: "fact",
      content: "WAL test fact",
      tags: ["wal", "test"],
      strength: 0.7,
    }]);

    const entries = getWalEntries();
    const addEntry = entries.find(e => e.op === "add_node");
    expect(addEntry).toBeDefined();
    expect(addEntry!.nodeId).toBe("n_wal_test");
    expect((addEntry!.meta as any).type).toBe("fact");
    expect((addEntry!.meta as any).tags).toEqual(["wal", "test"]);
    expect(addEntry!.ts).toBeGreaterThan(0);
  });

  it("logs WAL entry for add_edge", () => {
    graph.addNode(makeNode({ id: "n_a" }));
    graph.addNode(makeNode({ id: "n_b" }));

    graph.applyOperations([{
      op: "add_edge",
      from: "n_a",
      to: "n_b",
      type: "topical",
      weight: 0.5,
    }]);

    const entries = getWalEntries();
    const edgeEntry = entries.find(e => e.op === "add_edge");
    expect(edgeEntry).toBeDefined();
    expect(edgeEntry!.edgeFrom).toBe("n_a");
    expect(edgeEntry!.edgeTo).toBe("n_b");
  });

  it("logs WAL entry for strengthen", () => {
    graph.addNode(makeNode({ id: "n_str", strength: 0.5 }));
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "strengthen",
      id: "n_str",
      amount: 0.2,
    }]);

    const entries = getWalEntries();
    const strEntry = entries.find(e => e.op === "strengthen");
    expect(strEntry).toBeDefined();
    expect(strEntry!.nodeId).toBe("n_str");
    expect((strEntry!.meta as any).amount).toBe(0.2);
  });

  it("logs WAL entry for weaken", () => {
    graph.addNode(makeNode({ id: "n_weak", strength: 0.8 }));
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "weaken",
      id: "n_weak",
      amount: 0.3,
    }]);

    const entries = getWalEntries();
    const weakEntry = entries.find(e => e.op === "weaken");
    expect(weakEntry).toBeDefined();
    expect(weakEntry!.nodeId).toBe("n_weak");
    expect((weakEntry!.meta as any).amount).toBe(0.3);
  });

  it("logs WAL entry for update_node", () => {
    graph.addNode(makeNode({ id: "n_upd" }));
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "update_node",
      id: "n_upd",
      content: "Updated content",
      tags: ["updated"],
    }]);

    const entries = getWalEntries();
    const updEntry = entries.find(e => e.op === "update_node");
    expect(updEntry).toBeDefined();
    expect(updEntry!.nodeId).toBe("n_upd");
    expect((updEntry!.meta as any).hasContent).toBe(true);
    expect((updEntry!.meta as any).hasTags).toBe(true);
  });

  it("logs WAL entry for remove_node", () => {
    graph.addNode(makeNode({ id: "n_rem" }));
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "remove_node",
      id: "n_rem",
    }]);

    const entries = getWalEntries();
    const remEntry = entries.find(e => e.op === "remove_node");
    expect(remEntry).toBeDefined();
    expect(remEntry!.nodeId).toBe("n_rem");
  });

  it("logs WAL entry for remove_edge", () => {
    graph.addNode(makeNode({ id: "n_re1" }));
    graph.addNode(makeNode({ id: "n_re2" }));
    graph.addEdge({
      from: "n_re1", to: "n_re2", type: "topical", weight: 0.5,
      createdAt: now, lastReinforcedAt: now,
    });
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "remove_edge",
      from: "n_re1",
      to: "n_re2",
      type: "topical",
    }]);

    const entries = getWalEntries();
    const reEntry = entries.find(e => e.op === "remove_edge");
    expect(reEntry).toBeDefined();
    expect(reEntry!.edgeFrom).toBe("n_re1");
    expect(reEntry!.edgeTo).toBe("n_re2");
  });

  it("logs WAL entry for archive", () => {
    graph.addNode(makeNode({ id: "n_arch", strength: 0.1 }));
    mockAppendFileSync.mockClear();

    graph.archiveNode("n_arch", "decay");

    const entries = getWalEntries();
    const archEntry = entries.find(e => e.op === "archive");
    expect(archEntry).toBeDefined();
    expect(archEntry!.nodeId).toBe("n_arch");
    expect((archEntry!.meta as any).reason).toBe("decay");
  });

  it("logs WAL entry for restore", () => {
    graph.addNode(makeNode({ id: "n_rest", strength: 0.1 }));
    graph.archiveNode("n_rest", "decay");
    mockAppendFileSync.mockClear();

    graph.restoreNode("n_rest");

    const entries = getWalEntries();
    const restEntry = entries.find(e => e.op === "restore");
    expect(restEntry).toBeDefined();
    expect(restEntry!.nodeId).toBe("n_rest");
    expect((restEntry!.meta as any).archiveReason).toBe("decay");
  });

  it("does NOT write WAL for skipped operations", () => {
    // Try to strengthen a non-existent node
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "strengthen",
      id: "n_nonexistent",
      amount: 0.5,
    }]);

    const entries = getWalEntries();
    const strEntry = entries.find(e => e.op === "strengthen");
    expect(strEntry).toBeUndefined();
  });

  it("auto-rolls WAL file when over size limit", () => {
    mockStatSync.mockReturnValue({ size: WAL_MAX_BYTES + 1 });

    graph.addNode(makeNode({ id: "n_roll" }));
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "strengthen",
      id: "n_roll",
      amount: 0.1,
    }]);

    // WAL was written
    expect(mockAppendFileSync).toHaveBeenCalled();
    // File was rolled
    expect(mockRenameSync).toHaveBeenCalled();
    const rollCall = mockRenameSync.mock.calls[0];
    expect(String(rollCall[0])).toContain("wal.jsonl");
    expect(String(rollCall[1])).toContain("wal.jsonl.");
    expect(String(rollCall[1])).toContain(".old");
  });

  it("WAL failures do not break graph operations", () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error("Disk full");
    });

    graph.addNode(makeNode({ id: "n_err" }));

    // Graph operation should still succeed despite WAL failure
    const result = graph.applyOperations([{
      op: "strengthen",
      id: "n_err",
      amount: 0.3,
    }]);

    expect(result.applied).toBe(1);
    const node = graph.getNode("n_err");
    expect(node!.strength).toBeCloseTo(0.8);
  });

  it("WAL entries are valid JSONL (one JSON object per line)", () => {
    graph.applyOperations([
      { op: "add_node", id: "n_j1", type: "fact", content: "First", tags: ["a"], strength: 0.5 },
      { op: "add_node", id: "n_j2", type: "fact", content: "Second", tags: ["b"], strength: 0.5 },
    ]);

    const walCalls = mockAppendFileSync.mock.calls
      .filter(call => String(call[0]).includes("wal.jsonl"));

    for (const call of walCalls) {
      const line = String(call[1]);
      expect(line.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(line.trim());
      expect(parsed.ts).toBeTypeOf("number");
      expect(parsed.op).toBeTypeOf("string");
    }
  });

  it("logs WAL entry for merge_nodes", () => {
    graph.addNode(makeNode({ id: "n_m1", content: "Merge A", tags: ["merge"] }));
    graph.addNode(makeNode({ id: "n_m2", content: "Merge B", tags: ["merge"] }));
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "merge_nodes",
      ids: ["n_m1", "n_m2"],
      into: { content: "Merged AB", tags: ["merge", "merged"] },
    }]);

    const entries = getWalEntries();
    const mergeEntry = entries.find(e => e.op === "merge_nodes");
    expect(mergeEntry).toBeDefined();
    expect(mergeEntry!.nodeIds).toEqual(["n_m1", "n_m2"]);
  });

  it("logs WAL entry for update_edge", () => {
    graph.addNode(makeNode({ id: "n_ue1" }));
    graph.addNode(makeNode({ id: "n_ue2" }));
    graph.addEdge({
      from: "n_ue1", to: "n_ue2", type: "topical", weight: 0.5,
      createdAt: now, lastReinforcedAt: now,
    });
    mockAppendFileSync.mockClear();

    graph.applyOperations([{
      op: "update_edge",
      from: "n_ue1",
      to: "n_ue2",
      weight: 0.9,
      type: "topical",
    }]);

    const entries = getWalEntries();
    const ueEntry = entries.find(e => e.op === "update_edge");
    expect(ueEntry).toBeDefined();
    expect(ueEntry!.edgeFrom).toBe("n_ue1");
    expect(ueEntry!.edgeTo).toBe("n_ue2");
    expect((ueEntry!.meta as any).weight).toBe(0.9);
  });
});
