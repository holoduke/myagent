import { describe, it, expect, vi } from "vitest";

vi.mock("../../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  strictReadJSON: () => null,
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));
vi.mock("../../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain", OWNER_NAME: "TestOwner" }));
vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../../backend/memory/embeddings.js", () => ({ embedNode: vi.fn().mockResolvedValue(null), removeEmbedding: vi.fn() }));

import { emergencyPrune, applyEdgeDecay, EMERGENCY_PRUNE_TARGET } from "../../backend/memory/retention.js";
import { MemoryGraph } from "../../backend/memory/graph.js";
import type { MemoryNode, RetentionTier } from "../../backend/memory/types.js";
import { MAX_NODES_HARD } from "../../backend/memory/types.js";

const now = Date.now();
const node = (id: string, overrides: Partial<MemoryNode> = {}): MemoryNode =>
  ({ id, type: "event", content: id, tags: [], strength: 0.5, pinned: false, createdAt: now, lastAccessedAt: now, accessCount: 1, ...overrides });

describe("emergencyPrune", () => {
  it("does nothing under the hard limit", () => {
    const g = new MemoryGraph();
    g.addNode(node("a"));
    expect(emergencyPrune(g)).toBe(0);
  });

  it("prunes only down to 90% of the hard cap, never to the soft limit", () => {
    const g = new MemoryGraph();
    const total = MAX_NODES_HARD + 50;
    const tierCache = new Map<string, RetentionTier>();
    for (let i = 0; i < total; i++) {
      g.addNode(node(`n_${i}`, { strength: (i % 100) / 100 }));
      tierCache.set(`n_${i}`, "standard");
    }
    const pruned = emergencyPrune(g, tierCache);
    expect(EMERGENCY_PRUNE_TARGET).toBe(Math.floor(MAX_NODES_HARD * 0.9));
    expect(g.nodeCount).toBe(EMERGENCY_PRUNE_TARGET);
    expect(pruned).toBe(total - EMERGENCY_PRUNE_TARGET);
    expect(g.archiveSize + g.ghostCount).toBe(pruned); // archived, not deleted
  });
});

describe("applyEdgeDecay", () => {
  it("prunes only the decayed edge type between two nodes", () => {
    const g = new MemoryGraph();
    g.addNode(node("a", { strength: 0.9 }));
    g.addNode(node("b", { strength: 0.9 }));
    g.addEdge({ from: "a", to: "b", type: "topical", weight: 0.01, createdAt: now, lastReinforcedAt: now });
    g.addEdge({ from: "a", to: "b", type: "causal", weight: 0.8, createdAt: now, lastReinforcedAt: now });
    const { pruned } = applyEdgeDecay(g);
    expect(pruned).toBe(1);
    expect(g.hasEdge("a", "b", "topical")).toBe(false);
    expect(g.hasEdge("a", "b", "causal")).toBe(true);
  });
});
