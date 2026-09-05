import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from "fs";

const { TEST_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { TEST_DIR: mkdtempSync(join(tmpdir(), "graph-persist-")) };
});

vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: TEST_DIR, OWNER_NAME: "TestOwner" }));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../../backend/providers/embedding-provider.js", () => ({ embedSingle: vi.fn().mockResolvedValue(null) }));

import { MemoryGraph } from "../../backend/memory/graph.js";
import { readGeneration, writeGeneration, NODES_FILE, EDGES_FILE, ARCHIVE_FILE, GHOST_FILE, GRAPH_DIR } from "../../backend/memory/graph-persistence.js";
import type { MemoryNode } from "../../backend/memory/types.js";

const now = Date.now();
function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return { id: "n_x", type: "fact", content: "Some fact", tags: ["t"], strength: 0.5, pinned: false, createdAt: now, lastAccessedAt: now, accessCount: 1, ...overrides };
}

beforeEach(() => {
  rmSync(GRAPH_DIR, { recursive: true, force: true });
  mkdirSync(GRAPH_DIR, { recursive: true });
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("load()", () => {
  it("never writes, even when it repairs the graph", () => {
    writeFileSync(NODES_FILE, JSON.stringify({ n_a: makeNode({ id: "n_a", strength: Number.NaN }) }));
    writeFileSync(EDGES_FILE, JSON.stringify([{ from: "n_a", to: "n_missing", type: "topical", weight: 0.5, createdAt: now, lastReinforcedAt: now }]));
    const nodesBefore = readFileSync(NODES_FILE, "utf-8");
    const mtimeBefore = statSync(NODES_FILE).mtimeMs;

    const graph = new MemoryGraph();
    graph.load();

    expect(graph.getNode("n_a")!.strength).toBe(0.5);
    expect(graph.edgeCount).toBe(0);
    expect(graph.isDirty).toBe(true);
    expect(readFileSync(NODES_FILE, "utf-8")).toBe(nodesBefore);
    expect(statSync(NODES_FILE).mtimeMs).toBe(mtimeBefore);
    expect(existsSync(ARCHIVE_FILE)).toBe(false);
    expect(existsSync(`${GRAPH_DIR}/generation.json`)).toBe(false);
  });

  it("refuses to boot on a corrupted nodes file", () => {
    writeFileSync(NODES_FILE, "{ not json");
    expect(() => new MemoryGraph().load()).toThrow(/Failed to parse JSON/);
  });

  it("treats a corrupted archive as empty but write-protected", () => {
    writeFileSync(ARCHIVE_FILE, "{ broken");
    writeFileSync(GHOST_FILE, JSON.stringify({}));
    const graph = new MemoryGraph();
    graph.load();
    expect(graph.archiveSize).toBe(0);

    graph.addNode(makeNode({ id: "n_1" }));
    graph.archiveNode("n_1", "manual");
    expect(graph.save()).toBe(true);

    expect(readFileSync(ARCHIVE_FILE, "utf-8")).toBe("{ broken"); // never emptied
    expect(existsSync(NODES_FILE)).toBe(true);
    expect(JSON.parse(readFileSync(GHOST_FILE, "utf-8"))).toEqual({});
  });

  it("replaces in-memory state on reload", () => {
    const graph = new MemoryGraph();
    graph.load();
    graph.addNode(makeNode({ id: "n_mem" }));
    writeFileSync(NODES_FILE, JSON.stringify({ n_disk: makeNode({ id: "n_disk" }) }));
    graph.load();
    expect(graph.getNode("n_mem")).toBeUndefined();
    expect(graph.getNode("n_disk")).toBeDefined();
  });
});

describe("save() generation guard", () => {
  it("bumps the generation on every save and clears dirty", () => {
    const graph = new MemoryGraph();
    graph.load();
    expect(graph.generation).toBe(0);
    graph.addNode(makeNode({ id: "n_1" }));
    expect(graph.isDirty).toBe(true);
    expect(graph.save()).toBe(true);
    expect(graph.isDirty).toBe(false);
    expect(graph.generation).toBe(1);
    expect(readGeneration()).toBe(1);
    expect(graph.save()).toBe(true);
    expect(readGeneration()).toBe(2);
  });

  it("refuses to save when another writer has moved the on-disk generation", () => {
    const first = new MemoryGraph();
    first.load();
    first.addNode(makeNode({ id: "n_first" }));
    first.save();

    const second = new MemoryGraph();
    second.load();
    second.addNode(makeNode({ id: "n_second" }));
    second.save(); // generation 2

    first.addNode(makeNode({ id: "n_stale" }));
    expect(first.save()).toBe(false);
    expect(first.getNode("n_stale")).toBeDefined(); // kept in memory
    const onDisk = JSON.parse(readFileSync(NODES_FILE, "utf-8"));
    expect(Object.keys(onDisk)).toEqual(["n_first", "n_second"]);
    expect(readGeneration()).toBe(2);
  });

  it("a generation bump by restore makes stale holders refuse, and a reload recovers", () => {
    const graph = new MemoryGraph();
    graph.load();
    graph.save();
    writeGeneration(readGeneration() + 1);
    expect(graph.save()).toBe(false);
    graph.load();
    expect(graph.save()).toBe(true);
  });

  it("missing generation file defaults to 0 (no migration needed)", () => {
    expect(readGeneration()).toBe(0);
    writeFileSync(`${GRAPH_DIR}/generation.json`, "garbage");
    expect(readGeneration()).toBe(0);
  });
});
