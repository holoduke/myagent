/**
 * Tests for MMR (Maximal Marginal Relevance) diversity re-ranking.
 * Validates that MMR actually produces diverse results, not just relevance-sorted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Use hoisted mocks so we can manipulate the embedding cache
const { mockEmbeddingCache } = vi.hoisted(() => ({
  mockEmbeddingCache: new Map<string, number[]>(),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => {
    // Convert mockEmbeddingCache to a plain object for loading
    const obj: Record<string, number[]> = {};
    for (const [k, v] of mockEmbeddingCache) obj[k] = v;
    return obj;
  },
  atomicWriteJSON: vi.fn(),
  atomicWriteFile: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

vi.mock("../backend/providers/embedding-provider.js", () => ({
  embedSingle: vi.fn().mockResolvedValue(null),
  embed: vi.fn().mockResolvedValue([]),
}));

// Force re-import to pick up fresh mock state
beforeEach(() => {
  mockEmbeddingCache.clear();
  // Reset the module's internal cache by reimporting
  vi.resetModules();
});

describe("MMR diversity re-ranking", () => {
  // Import fresh for each test block to pick up cache changes
  async function getModule() {
    const mod = await import("../backend/memory/embeddings.js");
    return mod;
  }

  describe("cosine similarity", () => {
    it("returns 1 for identical unit vectors", async () => {
      const { cosine } = await getModule();
      expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    });

    it("returns 0 for orthogonal vectors", async () => {
      const { cosine } = await getModule();
      expect(cosine([1, 0], [0, 1])).toBeCloseTo(0.0);
    });

    it("returns -1 for opposite vectors", async () => {
      const { cosine } = await getModule();
      expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    });

    it("returns 0 for empty vectors", async () => {
      const { cosine } = await getModule();
      expect(cosine([], [])).toBe(0);
    });

    it("returns 0 for mismatched lengths", async () => {
      const { cosine } = await getModule();
      expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    });
  });

  describe("mmrRerank basic behavior", () => {
    it("returns single candidate unchanged", async () => {
      const { mmrRerank } = await getModule();
      const candidates = [{ nodeId: "a", similarity: 0.9 }];
      const result = mmrRerank([1, 0, 0], candidates, 5);
      expect(result).toHaveLength(1);
      expect(result[0].nodeId).toBe("a");
    });

    it("returns empty array for empty input", async () => {
      const { mmrRerank } = await getModule();
      const result = mmrRerank([1, 0, 0], [], 5);
      expect(result).toHaveLength(0);
    });

    it("respects topK limit", async () => {
      const { mmrRerank } = await getModule();
      const candidates = [
        { nodeId: "a", similarity: 0.9 },
        { nodeId: "b", similarity: 0.85 },
        { nodeId: "c", similarity: 0.8 },
        { nodeId: "d", similarity: 0.7 },
        { nodeId: "e", similarity: 0.6 },
      ];
      const result = mmrRerank([1, 0, 0], candidates, 3);
      expect(result).toHaveLength(3);
    });

    it("with lambda=1.0, sorts by pure relevance", async () => {
      const { mmrRerank } = await getModule();
      const candidates = [
        { nodeId: "low", similarity: 0.4 },
        { nodeId: "high", similarity: 0.95 },
        { nodeId: "mid", similarity: 0.7 },
      ];
      const result = mmrRerank([1, 0, 0], candidates, 3, 1.0);
      expect(result[0].nodeId).toBe("high");
      expect(result[1].nodeId).toBe("mid");
      expect(result[2].nodeId).toBe("low");
    });
  });

  describe("mmrRerank diversity behavior with seeded embeddings", () => {
    it("selects diverse candidate over redundant high-relevance duplicate", async () => {
      // Seed 4 embeddings: A, B, C are near-identical (same direction), D is orthogonal
      mockEmbeddingCache.set("dup1", [0.9, 0.1, 0.0]);
      mockEmbeddingCache.set("dup2", [0.88, 0.12, 0.0]);
      mockEmbeddingCache.set("dup3", [0.91, 0.09, 0.0]);
      mockEmbeddingCache.set("diverse", [0.0, 0.0, 0.95]);

      const { mmrRerank } = await getModule();

      // All 3 dups have higher relevance than the diverse one
      const candidates = [
        { nodeId: "dup1", similarity: 0.95 },
        { nodeId: "dup2", similarity: 0.92 },
        { nodeId: "dup3", similarity: 0.90 },
        { nodeId: "diverse", similarity: 0.70 },
      ];

      // With lambda=0.5 (balanced), MMR should prefer diverse over 3rd duplicate
      const result = mmrRerank([1, 0, 0], candidates, 3, 0.5);
      const selectedIds = result.map(r => r.nodeId);

      // First pick is always highest relevance
      expect(selectedIds[0]).toBe("dup1");
      // The diverse node should appear in top 3 despite lower relevance
      expect(selectedIds).toContain("diverse");
    });

    it("with lambda=1.0, ignores diversity and picks top by relevance", async () => {
      mockEmbeddingCache.set("dup1", [0.9, 0.1, 0.0]);
      mockEmbeddingCache.set("dup2", [0.88, 0.12, 0.0]);
      mockEmbeddingCache.set("dup3", [0.91, 0.09, 0.0]);
      mockEmbeddingCache.set("diverse", [0.0, 0.0, 0.95]);

      const { mmrRerank } = await getModule();

      const candidates = [
        { nodeId: "dup1", similarity: 0.95 },
        { nodeId: "dup2", similarity: 0.92 },
        { nodeId: "dup3", similarity: 0.90 },
        { nodeId: "diverse", similarity: 0.70 },
      ];

      // lambda=1.0 → pure relevance, no diversity penalty
      const result = mmrRerank([1, 0, 0], candidates, 3, 1.0);
      const selectedIds = result.map(r => r.nodeId);

      expect(selectedIds).toEqual(["dup1", "dup2", "dup3"]);
      expect(selectedIds).not.toContain("diverse");
    });

    it("with lambda=0.0, maximizes diversity over relevance", async () => {
      // Three clusters: A-group, B-group, C-group
      mockEmbeddingCache.set("a1", [1.0, 0.0, 0.0]);
      mockEmbeddingCache.set("a2", [0.95, 0.05, 0.0]);
      mockEmbeddingCache.set("b1", [0.0, 1.0, 0.0]);
      mockEmbeddingCache.set("c1", [0.0, 0.0, 1.0]);

      const { mmrRerank } = await getModule();

      const candidates = [
        { nodeId: "a1", similarity: 0.9 },
        { nodeId: "a2", similarity: 0.85 },
        { nodeId: "b1", similarity: 0.5 },
        { nodeId: "c1", similarity: 0.4 },
      ];

      // lambda=0.0 → pure diversity
      const result = mmrRerank([1, 0, 0], candidates, 3, 0.0);
      const selectedIds = result.map(r => r.nodeId);

      // Should pick one from each cluster rather than two from A
      expect(selectedIds).toContain("b1");
      expect(selectedIds).toContain("c1");
    });
  });

  describe("mmrRerank with missing embeddings", () => {
    it("treats nodes without embeddings as moderately similar (not maximally diverse)", async () => {
      // Only seed one embedding — others will be missing
      mockEmbeddingCache.set("has_vec", [1.0, 0.0, 0.0]);

      const { mmrRerank } = await getModule();

      const candidates = [
        { nodeId: "has_vec", similarity: 0.9 },
        { nodeId: "no_vec", similarity: 0.85 },
      ];

      const result = mmrRerank([1, 0, 0], candidates, 2, 0.7);

      // Both should be selected (only 2 candidates, topK=2)
      expect(result).toHaveLength(2);
      // First should still be the highest relevance one
      expect(result[0].nodeId).toBe("has_vec");
    });
  });

  describe("semanticSearchByVector", () => {
    it("returns empty array when no embeddings", async () => {
      const { semanticSearchByVector } = await getModule();
      const result = semanticSearchByVector([1, 0, 0], 10);
      expect(result).toHaveLength(0);
    });
  });
});
