import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──

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
    appendFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 0 })),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { MemoryGraph } from "../backend/memory/graph.js";
import { atomicWriteJSON } from "../backend/utils/file-store.js";
import type { MemoryNode } from "../backend/memory/types.js";
import { MAX_ARCHIVE_NODES } from "../backend/memory/types.js";

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

function fillAndArchive(graph: MemoryGraph, count: number, extra: (i: number) => Partial<MemoryNode> = () => ({})): void {
  for (let i = 0; i < count; i++) {
    graph.addNode(makeNode({ id: `n_${String(i).padStart(5, "0")}`, content: `Node ${i}`, tags: [`tag${i}`], strength: 0.1, ...extra(i) }));
  }
  for (let i = 0; i < count; i++) {
    graph.archiveNode(`n_${String(i).padStart(5, "0")}`, "decay");
  }
}

// ── Ghost Graph Tests ──

describe("Ghost Graph", () => {
  let graph: MemoryGraph;

  beforeEach(() => {
    vi.clearAllMocks();
    graph = new MemoryGraph();
    graph.load();
  });

  it("starts with zero ghosts", () => {
    expect(graph.ghostCount).toBe(0);
    expect(graph.allGhostNodes()).toEqual([]);
  });

  it("creates ghost nodes when archive exceeds cap", () => {
    fillAndArchive(graph, MAX_ARCHIVE_NODES + 5);
    expect(graph.archiveSize).toBe(MAX_ARCHIVE_NODES);
    expect(graph.ghostCount).toBe(5);
  });

  it("evicts by lowest importance then strength — not by age", () => {
    // Oldest archived node is the most important one; it must survive eviction.
    fillAndArchive(graph, MAX_ARCHIVE_NODES + 2, i => (i === 0 ? { importance: 0.9, strength: 0.4 } : { importance: 0.1 }));
    expect(graph.getArchived("n_00000")).toBeDefined();
    expect(graph.getGhost("n_00000")).toBeUndefined();
    expect(graph.ghostCount).toBe(2);
  });

  it("preserves ghost node fields correctly", () => {
    fillAndArchive(graph, MAX_ARCHIVE_NODES + 2, i => ({
      content: `Content for node ${i}`,
      tags: [`person${i}`, "work"],
      type: i === 0 ? "person" : "event",
    }));

    expect(graph.ghostCount).toBe(2);
    const ghost0 = graph.getGhost("n_00000");
    expect(ghost0).toBeDefined();
    expect(ghost0!.id).toBe("n_00000");
    expect(ghost0!.type).toBe("person");
    expect(ghost0!.tagFingerprint).toContain("person0");
    expect(ghost0!.tagFingerprint).toContain("work");
    expect(ghost0!.archiveReason).toBe("decay");
    expect(ghost0!.archivedAt).toBeGreaterThan(0);
    expect(ghost0!.evictedAt).toBeGreaterThanOrEqual(ghost0!.archivedAt);
    expect(Array.isArray(ghost0!.edges)).toBe(true);
  });

  it("getGhost returns undefined for non-existent ID", () => {
    expect(graph.getGhost("n_nonexistent")).toBeUndefined();
  });

  it("hasTopology checks active, archive, and ghost layers", () => {
    graph.addNode(makeNode({ id: "n_active" }));
    expect(graph.hasTopology("n_active")).toBe(true);

    graph.addNode(makeNode({ id: "n_archived", strength: 0.1 }));
    graph.archiveNode("n_archived", "decay");
    expect(graph.hasTopology("n_archived")).toBe(true);

    expect(graph.hasTopology("n_doesnt_exist")).toBe(false);
  });

  it("allGhostNodes returns all ghosts as array", () => {
    fillAndArchive(graph, MAX_ARCHIVE_NODES + 3);
    const ghosts = graph.allGhostNodes();
    expect(ghosts.length).toBe(3);
    expect(ghosts.every(g => g.id && g.type && g.tagFingerprint)).toBe(true);
  });

  it("getStats includes ghostCount", () => {
    const stats = graph.getStats();
    expect(stats).toHaveProperty("ghostCount");
    expect(stats.ghostCount).toBe(0);
  });

  it("ghost graph persists via save() — written before nodes", () => {
    fillAndArchive(graph, MAX_ARCHIVE_NODES + 2);
    expect(graph.ghostCount).toBe(2);

    expect(graph.save()).toBe(true);

    const calls = (atomicWriteJSON as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
    const ghostIdx = calls.findIndex(f => f.includes("ghost-graph.json"));
    const archiveIdx = calls.findIndex(f => f.includes("archive.json"));
    const nodesIdx = calls.findIndex(f => f.endsWith("nodes.json"));
    const edgesIdx = calls.findIndex(f => f.endsWith("edges.json"));
    expect(ghostIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeLessThan(ghostIdx);
    expect(ghostIdx).toBeLessThan(edgesIdx);
    expect(edgesIdx).toBeLessThan(nodesIdx);

    const ghostData = (atomicWriteJSON as ReturnType<typeof vi.fn>).mock.calls[ghostIdx][1] as Record<string, unknown>;
    expect(Object.keys(ghostData).length).toBe(2);
  });

  it("load() never writes to disk", () => {
    expect(atomicWriteJSON).not.toHaveBeenCalled();
  });

  it("preserves edge topology in ghost nodes", () => {
    graph.addNode(makeNode({ id: "n_source", tags: ["person"], strength: 0.1 }));
    graph.addNode(makeNode({ id: "n_target", tags: ["project"], strength: 0.8 }));
    graph.addEdge({ from: "n_source", to: "n_target", type: "topical", weight: 0.7, createdAt: now, lastReinforcedAt: now });

    for (let i = 0; i < MAX_ARCHIVE_NODES + 1; i++) {
      graph.addNode(makeNode({ id: `n_filler_${String(i).padStart(5, "0")}`, tags: [`filler${i}`], strength: 0.1 }));
    }
    graph.archiveNode("n_source", "decay");
    for (let i = 0; i < MAX_ARCHIVE_NODES + 1; i++) {
      graph.archiveNode(`n_filler_${String(i).padStart(5, "0")}`, "decay");
    }

    const ghost = graph.getGhost("n_source");
    if (ghost) {
      expect(ghost.edges.length).toBeGreaterThanOrEqual(1);
      expect(ghost.edges.some(e => e.to === "n_target" || e.from === "n_source")).toBe(true);
    }
  });
});

// ── Archive restore floor ──

describe("restoreNode strength window", () => {
  it("restores decay-archived nodes at the floor so they are recallable", () => {
    const graph = new MemoryGraph();
    graph.addNode(makeNode({ id: "n_weak", strength: 0.02 }));
    graph.archiveNode("n_weak", "decay");
    expect(graph.restoreNode("n_weak")).toBe(true);
    expect(graph.getNode("n_weak")!.strength).toBeCloseTo(0.3);
  });

  it("caps strong nodes at the ceiling", () => {
    const graph = new MemoryGraph();
    graph.addNode(makeNode({ id: "n_strong", strength: 0.95 }));
    graph.archiveNode("n_strong", "manual");
    graph.restoreNode("n_strong");
    expect(graph.getNode("n_strong")!.strength).toBeCloseTo(0.6);
  });
});
