import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// Embeddings are controlled per test: `embeddings` maps node id → vector.
const { embeddings } = vi.hoisted(() => ({ embeddings: new Map<string, number[]>() }));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
  getNodeEmbedding: (id: string) => embeddings.get(id) ?? null,
  cosine: (a: number[], b: number[]) => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  },
}));

import {
  detectConflicts,
  resolveConflicts,
  promoteEpisodicToSemantic,
  runSleepConsolidation,
  DUPLICATE_MIN_JACCARD,
} from "../backend/sleep-consolidation.js";
import type { MemoryNode } from "../backend/memory/types.js";
import { tokenJaccard, tokenOverlap } from "../backend/memory/text-utils.js";

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

function readOnlyGraph(facts: MemoryNode[], edgesFor: (id: string) => unknown[] = () => []) {
  return {
    findByType: vi.fn().mockImplementation((type: string) => (type === "fact" ? facts : [])),
    allEdges: vi.fn().mockReturnValue([]),
    edgesFor: vi.fn().mockImplementation(edgesFor),
  } as any;
}

beforeEach(() => embeddings.clear());

describe("detectConflicts", () => {
  const DUP_A = makeNode({ id: "f1", content: "Lucas is eight years old and goes to school", tags: ["lucas", "age"] });
  const DUP_B = makeNode({ id: "f2", content: "Lucas is eight years old and he goes to school daily", tags: ["lucas", "age", "school"] });

  it("returns empty for graph with no facts", () => {
    expect(detectConflicts(readOnlyGraph([]))).toEqual([]);
  });

  it("detects near-duplicates when BOTH cosine > 0.85 and Jaccard >= 0.5", () => {
    embeddings.set("f1", [1, 0.1, 0]);
    embeddings.set("f2", [1, 0.12, 0]);
    expect(tokenJaccard(DUP_A.content, DUP_B.content)).toBeGreaterThanOrEqual(DUPLICATE_MIN_JACCARD);

    const conflicts = detectConflicts(readOnlyGraph([DUP_A, DUP_B]));
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].conflictType).toBe("near-duplicate");
  });

  it("does not call high token overlap a duplicate without embedding agreement", () => {
    // No embeddings at all → cannot confirm → no merge
    expect(detectConflicts(readOnlyGraph([DUP_A, DUP_B]))).toEqual([]);
  });

  it("does not merge semantically close nodes whose wording differs", () => {
    const a = makeNode({ id: "f1", content: "Gillis works at NewStory as a developer", tags: ["gillis", "work"] });
    const b = makeNode({ id: "f2", content: "The company employing him builds apps in Amsterdam", tags: ["gillis", "work"] });
    embeddings.set("f1", [1, 0, 0]);
    embeddings.set("f2", [1, 0.05, 0]); // cosine ≈ 0.999
    const conflicts = detectConflicts(readOnlyGraph([a, b]));
    expect(conflicts.some(c => c.conflictType === "near-duplicate")).toBe(false);
  });

  it("detects contradictions via explicit contradicts edges", () => {
    const a = makeNode({ id: "f1", content: "Lucas prefers football", tags: ["lucas", "sport"] });
    const b = makeNode({ id: "f2", content: "Lucas dislikes football", tags: ["lucas", "sport"] });
    const graph = readOnlyGraph([a, b], (id: string) => (id === "f1" ? [{ from: "f1", to: "f2", type: "contradicts", weight: 0.8 }] : []));
    expect(detectConflicts(graph).some(c => c.conflictType === "contradiction")).toBe(true);
  });

  it("semantic near-miss counts as contradiction only with token overlap >= 0.3", () => {
    const a = makeNode({ id: "f1", content: "Lucas plays football on Saturday mornings", tags: ["lucas", "sport"] });
    const unrelated = makeNode({ id: "f2", content: "Naomi enjoys painting watercolours", tags: ["lucas", "sport"] });
    const overlapping = makeNode({ id: "f3", content: "Lucas plays football on Sunday evenings", tags: ["lucas", "sport"] });
    embeddings.set("f1", [1, 0, 0]);
    embeddings.set("f2", [0.8, 0.6, 0]); // cosine 0.8 but no shared words
    embeddings.set("f3", [0.8, 0.6, 0]); // cosine 0.8: too low for a duplicate, high enough for a near-miss
    expect(tokenOverlap(a.content, unrelated.content)).toBeLessThan(0.3);
    expect(tokenOverlap(a.content, overlapping.content)).toBeGreaterThanOrEqual(0.3);

    const conflicts = detectConflicts(readOnlyGraph([a, unrelated, overlapping]));
    const pairIds = conflicts.map(c => `${c.nodeA.id}-${c.nodeB.id}:${c.conflictType}`);
    expect(pairIds).not.toContain("f1-f2:contradiction");
    expect(pairIds).toContain("f1-f3:contradiction");
  });
});

describe("resolveConflicts", () => {
  it("merges near-duplicates by archiving the loser with its content in the merge note", () => {
    const keep = makeNode({ id: "f1", strength: 0.8, content: "Lucas is eight", tags: ["lucas"] });
    const lose = makeNode({ id: "f2", strength: 0.4, content: "Lucas is 8 years old", tags: ["lucas", "age"] });
    const nodes = new Map([[keep.id, keep], [lose.id, lose]]);
    const graph = {
      getNode: vi.fn().mockImplementation((id: string) => nodes.get(id)),
      updateNode: vi.fn(),
      edgesFor: vi.fn().mockReturnValue([{ from: "f2", to: "other", type: "topical", weight: 0.5, createdAt: now, lastReinforcedAt: now }]),
      addEdge: vi.fn(),
      archiveNode: vi.fn().mockReturnValue(true),
      applyOperations: vi.fn(),
    } as any;

    const resolved = resolveConflicts(graph, [{ nodeA: keep, nodeB: lose, conflictType: "near-duplicate", similarity: 0.9 }]);
    expect(resolved).toBe(1);
    expect(graph.updateNode).toHaveBeenCalledWith("f1", expect.objectContaining({
      content: expect.stringContaining("Lucas is 8 years old"),
      tags: expect.arrayContaining(["lucas", "age"]),
    }));
    expect(graph.addEdge).toHaveBeenCalledWith(expect.objectContaining({ from: "f1", to: "other" }));
    expect(graph.archiveNode).toHaveBeenCalledWith("f2", "consolidation");
    expect(graph.applyOperations).not.toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ op: "remove_node" })]));
  });

  it("weakens contradicted nodes", () => {
    const graph = { applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0, dropped: 0 }) } as any;
    const pairs = [{
      nodeA: makeNode({ id: "f1", strength: 0.3 }),
      nodeB: makeNode({ id: "f2", strength: 0.7 }),
      conflictType: "contradiction" as const,
      similarity: 0.4,
    }];
    expect(resolveConflicts(graph, pairs)).toBe(1);
    const call = graph.applyOperations.mock.calls[0][0][0];
    expect(call.op).toBe("weaken");
    expect(call.id).toBe("f1");
  });
});

describe("promoteEpisodicToSemantic", () => {
  it("promotes frequently-accessed old events", () => {
    const old = Date.now() - 14 * 24 * 3600_000;
    const graph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "e1", type: "event" as any, accessCount: 15, createdAt: old, lastAccessedAt: now, strength: 0.6, tags: ["meeting"] }),
      ]),
      updateNode: vi.fn(),
    } as any;
    expect(promoteEpisodicToSemantic(graph)).toBe(1);
    expect(graph.updateNode).toHaveBeenCalled();
  });

  it("skips already-promoted events", () => {
    const old = Date.now() - 14 * 24 * 3600_000;
    const graph = {
      findByType: vi.fn().mockReturnValue([
        makeNode({ id: "e1", type: "event" as any, accessCount: 15, createdAt: old, strength: 0.6, tags: ["meeting", "promoted-to-semantic"] }),
      ]),
    } as any;
    expect(promoteEpisodicToSemantic(graph)).toBe(0);
  });
});

describe("runSleepConsolidation", () => {
  it("returns consolidation result", () => {
    const result = runSleepConsolidation(readOnlyGraph([]));
    expect(result.conflictsDetected).toBe(0);
    expect(result.conflictsResolved).toBe(0);
    expect(result.promotedToSemantic).toBe(0);
  });
});
