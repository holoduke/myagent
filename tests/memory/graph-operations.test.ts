import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../backend/utils/file-store.js", () => ({
  safeReadJSON: (_path: string, defaultValue: unknown) => defaultValue,
  strictReadJSON: () => null,
  atomicWriteJSON: vi.fn(),
  atomicWriteFile: () => {},
  ensureDir: () => {},
}));
vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain", OWNER_NAME: "TestOwner" }));
vi.mock("../../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
  removeEmbedding: vi.fn(),
}));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { MemoryGraph } from "../../backend/memory/graph.js";
import { validateOperations } from "../../backend/memory/graph-operations.js";
import { pickEnrichmentTags } from "../../backend/memory/graph-correlate.js";
import { embedNode } from "../../backend/memory/embeddings.js";
import type { MemoryNode } from "../../backend/memory/types.js";
import { MAX_DESTRUCTIVE_OPS_PER_BATCH, MAX_PINNED_NODES, MAX_TAGS_PER_NODE } from "../../backend/memory/types.js";

const now = Date.now();
function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return { id: "n_x", type: "fact", content: "Some fact", tags: ["t"], strength: 0.5, pinned: false, createdAt: now, lastAccessedAt: now, accessCount: 1, ...overrides };
}

let graph: MemoryGraph;
beforeEach(() => {
  vi.clearAllMocks();
  graph = new MemoryGraph();
});

describe("validateOperations", () => {
  it("drops non-object and unknown ops", () => {
    const { valid, dropped } = validateOperations(["nope", null, { op: "explode" }]);
    expect(valid).toEqual([]);
    expect(dropped.length).toBe(3);
  });

  it("drops add_node with missing content, non-string tags, unknown type or bad strength", () => {
    const base = { op: "add_node", id: "n_1", type: "fact", content: "ok", tags: ["a"] };
    const cases = [
      { ...base, content: "" },
      { ...base, content: 42 },
      { ...base, tags: ["a", 7] },
      { ...base, type: "wizard" },
      { ...base, strength: 1.5 },
      { ...base, strength: Number.NaN },
      { ...base, importance: -0.1 },
    ];
    const { valid, dropped } = validateOperations(cases);
    expect(valid).toEqual([]);
    expect(dropped.map(d => d.reason)).toEqual([
      "add_node: missing/invalid content",
      "add_node: missing/invalid content",
      "add_node: tags must be an array of strings",
      'add_node: unknown node type "wizard"',
      "add_node: strength out of range (1.5)",
      "add_node: strength out of range (NaN)",
      "add_node: importance out of range (-0.1)",
    ]);
  });

  it("keeps well-formed ops and defaults missing tags", () => {
    const { valid } = validateOperations([{ op: "add_node", id: " n_1 ", type: "person", content: "Alice" }]);
    expect(valid).toEqual([{ op: "add_node", id: "n_1", type: "person", content: "Alice", tags: [] }]);
  });

  it("drops strengthen/weaken with non-finite or out-of-range amounts", () => {
    const { valid, dropped } = validateOperations([
      { op: "strengthen", id: "a", amount: 0.2 },
      { op: "strengthen", id: "a", amount: Infinity },
      { op: "weaken", id: "a", amount: 2 },
      { op: "weaken", id: "a", amount: 0 },
    ]);
    expect(valid.length).toBe(1);
    expect(dropped.length).toBe(3);
  });

  it("validates edges: type must be known and weight in [0,1]", () => {
    const { valid, dropped } = validateOperations([
      { op: "add_edge", from: "a", to: "b", type: "topical", weight: 0.5 },
      { op: "add_edge", from: "a", to: "b", type: "friendship", weight: 0.5 },
      { op: "add_edge", from: "a", to: "b", type: "topical", weight: "0.5" },
      { op: "add_edge", from: "a", type: "topical", weight: 0.5 },
    ]);
    expect(valid.length).toBe(1);
    expect(dropped.length).toBe(3);
  });

  it("merge_nodes needs two ids and into.content", () => {
    const { valid, dropped } = validateOperations([
      { op: "merge_nodes", ids: ["a"], into: { content: "x", tags: [] } },
      { op: "merge_nodes", ids: ["a", "b"], into: { tags: [] } },
      { op: "merge_nodes", ids: ["a", "b"], into: { content: "x" } },
    ]);
    expect(valid.length).toBe(1);
    expect(dropped.length).toBe(2);
  });

  it("never throws on a non-array payload", () => {
    expect(validateOperations({ op: "add_node" }).valid).toEqual([]);
  });
});

describe("applyOperations safety rules", () => {
  it("reports dropped ops separately and applies the rest", () => {
    const result = graph.applyOperations([
      { op: "add_node", id: "n_ok", type: "fact", content: "fine", tags: ["x"] },
      { op: "add_node", id: "n_bad", type: "fact", content: "", tags: [] },
    ]);
    expect(result).toEqual({ applied: 1, skipped: 0, dropped: 1 });
    expect(graph.getNode("n_ok")).toBeDefined();
  });

  it("embeds a new node exactly once", () => {
    graph.applyOperations([{ op: "add_node", id: "n_e", type: "fact", content: "embed me", tags: [] }]);
    expect(embedNode).toHaveBeenCalledTimes(1);
  });

  it("remove_node archives instead of deleting", () => {
    graph.addNode(makeNode({ id: "n_r", content: "keep me around" }));
    const result = graph.applyOperations([{ op: "remove_node", id: "n_r" }]);
    expect(result.applied).toBe(1);
    expect(graph.getNode("n_r")).toBeUndefined();
    expect(graph.getArchived("n_r")?.archiveReason).toBe("manual");
    expect(graph.getArchived("n_r")?.content).toBe("keep me around");
  });

  it("refuses remove_node and merge_nodes on pinned nodes", () => {
    graph.addNode(makeNode({ id: "n_pin", pinned: true }));
    graph.addNode(makeNode({ id: "n_other" }));
    const result = graph.applyOperations([
      { op: "remove_node", id: "n_pin" },
      { op: "merge_nodes", ids: ["n_pin", "n_other"], into: { content: "merged", tags: [] } },
    ]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(2);
    expect(graph.getNode("n_pin")).toBeDefined();
    expect(graph.getNode("n_other")).toBeDefined();
  });

  it("caps destructive ops per batch", () => {
    const ids = Array.from({ length: MAX_DESTRUCTIVE_OPS_PER_BATCH + 3 }, (_, i) => `n_d${i}`);
    for (const id of ids) graph.addNode(makeNode({ id }));
    const result = graph.applyOperations(ids.map(id => ({ op: "remove_node", id })));
    expect(result.applied).toBe(MAX_DESTRUCTIVE_OPS_PER_BATCH);
    expect(result.skipped).toBe(3);
    expect(graph.nodeCount).toBe(3);
  });

  it("merge_nodes carries salience metadata from the most important survivor and archives the originals", () => {
    graph.addNode(makeNode({ id: "n_a", importance: 0.2, confidence: 0.4, emotionalValence: -0.5, validFrom: 1, validUntil: 2, ingestedAt: 10 }));
    graph.addNode(makeNode({ id: "n_b", importance: 0.9, confidence: 0.8, emotionalValence: 0.7, validFrom: 3, validUntil: 4, ingestedAt: 20 }));
    graph.addNode(makeNode({ id: "n_c" }));
    graph.addEdge({ from: "n_a", to: "n_c", type: "topical", weight: 0.5, createdAt: now, lastReinforcedAt: now });

    const result = graph.applyOperations([{ op: "merge_nodes", ids: ["n_a", "n_b"], into: { content: "merged", tags: ["m"] } }]);
    expect(result.applied).toBe(1);

    const merged = graph.allNodes().find(n => n.content === "merged")!;
    expect(merged).toMatchObject({ importance: 0.9, confidence: 0.8, emotionalValence: 0.7, validFrom: 3, validUntil: 4, ingestedAt: 20 });
    expect(graph.hasEdge(merged.id, "n_c", "topical")).toBe(true);
    expect(graph.getArchived("n_a")?.archiveReason).toBe("consolidation");
    expect(graph.getArchived("n_b")?.archiveReason).toBe("consolidation");
  });

  it("re-mints an LLM id that collides with an archived node and remaps later ops in the batch", () => {
    graph.addNode(makeNode({ id: "n_old" }));
    graph.archiveNode("n_old", "decay");
    graph.addNode(makeNode({ id: "n_target" }));

    const result = graph.applyOperations([
      { op: "add_node", id: "n_old", type: "fact", content: "new content", tags: [] },
      { op: "add_edge", from: "n_old", to: "n_target", type: "topical", weight: 0.4 },
    ]);
    expect(result.applied).toBe(2);
    expect(graph.getArchived("n_old")).toBeDefined(); // untouched
    const fresh = graph.allNodes().find(n => n.content === "new content")!;
    expect(fresh.id).not.toBe("n_old");
    expect(graph.hasEdge(fresh.id, "n_target", "topical")).toBe(true);
  });

  it("skips add_node for an id that is already active", () => {
    graph.addNode(makeNode({ id: "n_dup" }));
    expect(graph.applyOperations([{ op: "add_node", id: "n_dup", type: "fact", content: "again", tags: [] }]).skipped).toBe(1);
  });

  it("ignores pins below the importance floor and honours them above it", () => {
    graph.applyOperations([
      { op: "add_node", id: "n_low", type: "fact", content: "low", tags: [], pinned: true, importance: 0.3 },
      { op: "add_node", id: "n_high", type: "fact", content: "high", tags: [], pinned: true, importance: 0.8 },
      { op: "add_node", id: "n_none", type: "fact", content: "none", tags: [], pinned: true },
    ]);
    expect(graph.getNode("n_low")!.pinned).toBe(false);
    expect(graph.getNode("n_high")!.pinned).toBe(true);
    expect(graph.getNode("n_none")!.pinned).toBe(false);
  });

  it("update_node pin needs importance too, and unpinning always works", () => {
    graph.addNode(makeNode({ id: "n_u", importance: 0.2 }));
    graph.applyOperations([{ op: "update_node", id: "n_u", pinned: true }]);
    expect(graph.getNode("n_u")!.pinned).toBe(false);
    graph.applyOperations([{ op: "update_node", id: "n_u", pinned: true, importance: 0.9 }]);
    expect(graph.getNode("n_u")!.pinned).toBe(true);
    graph.applyOperations([{ op: "update_node", id: "n_u", pinned: false }]);
    expect(graph.getNode("n_u")!.pinned).toBe(false);
  });

  it("ignores pins beyond the global pinned cap", () => {
    for (let i = 0; i < MAX_PINNED_NODES; i++) graph.addNode(makeNode({ id: `n_p${i}`, pinned: true }));
    graph.applyOperations([{ op: "add_node", id: "n_extra", type: "fact", content: "extra", tags: [], pinned: true, importance: 0.9 }]);
    expect(graph.getNode("n_extra")!.pinned).toBe(false);
    expect(graph.pinnedCount).toBe(MAX_PINNED_NODES);
  });

  it("strengthen and weaken clamp to [0,1]", () => {
    graph.addNode(makeNode({ id: "n_s", strength: 0.95 }));
    graph.applyOperations([{ op: "strengthen", id: "n_s", amount: 0.2 }]);
    expect(graph.getNode("n_s")!.strength).toBe(1);
    graph.applyOperations([{ op: "weaken", id: "n_s", amount: 1 }]);
    expect(graph.getNode("n_s")!.strength).toBe(0);
  });

  it("remove_edge with a type leaves other edge types between the same nodes", () => {
    graph.addNode(makeNode({ id: "n_1" }));
    graph.addNode(makeNode({ id: "n_2" }));
    graph.addEdge({ from: "n_1", to: "n_2", type: "topical", weight: 0.5, createdAt: now, lastReinforcedAt: now });
    graph.addEdge({ from: "n_1", to: "n_2", type: "causal", weight: 0.5, createdAt: now, lastReinforcedAt: now });
    graph.applyOperations([{ op: "remove_edge", from: "n_1", to: "n_2", type: "topical" }]);
    expect(graph.hasEdge("n_1", "n_2", "topical")).toBe(false);
    expect(graph.hasEdge("n_1", "n_2", "causal")).toBe(true);
  });
});

describe("tag enrichment", () => {
  it("never copies retention-tier signal tags and respects the per-node cap", () => {
    expect(pickEnrichmentTags(["family", "owner", "hiking", "x"], ["a"])).toEqual(["hiking"]);
    const full = Array.from({ length: MAX_TAGS_PER_NODE - 1 }, (_, i) => `t${i}`);
    expect(pickEnrichmentTags(["alpha", "beta"], full)).toEqual(["alpha"]);
    expect(pickEnrichmentTags(["alpha"], [...full, "last"])).toEqual([]);
  });

  it("correlation enriches through updateNode so the byTag index stays consistent", () => {
    graph.addNode(makeNode({ id: "n_exist", content: "Lucas football training every tuesday evening", tags: ["lucas", "football"] }));
    const fresh = makeNode({ id: "n_new", content: "Lucas football training moved to wednesday evening", tags: ["lucas", "football", "schedule", "family"] });
    graph.addNode(fresh);
    graph.correlateNode(fresh);
    const enriched = graph.getNode("n_exist")!;
    expect(enriched.tags).toContain("schedule");
    expect(enriched.tags).not.toContain("family");
    expect(graph.findByTag("schedule").map(n => n.id)).toContain("n_exist");
  });
});
