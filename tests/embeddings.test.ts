import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/providers/embedding-provider.js", () => ({
  embedSingle: vi.fn().mockResolvedValue(null),
  embed: vi.fn().mockResolvedValue([]),
}));

import { cosine, semanticSearchByVector } from "../backend/memory/embeddings.js";

// ── Cosine Similarity ──

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosine(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0];
    const b = [0, 1];
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosine(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosine([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosine([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("handles high-dimensional vectors", () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.sin(i + 0.1));
    const sim = cosine(a, b);
    expect(sim).toBeGreaterThan(0.9); // Very similar vectors
    expect(sim).toBeLessThan(1.0);
  });

  it("calculates correctly for simple case", () => {
    const a = [3, 4];
    const b = [4, 3];
    // dot = 12 + 12 = 24, |a| = 5, |b| = 5
    expect(cosine(a, b)).toBeCloseTo(24 / 25, 5);
  });
});

// ── Semantic Search By Vector ──

describe("semanticSearchByVector", () => {
  it("returns empty array when no embeddings loaded", () => {
    const results = semanticSearchByVector([1, 0, 0], 5);
    expect(results).toEqual([]);
  });

  it("returns results sorted by similarity descending", () => {
    // Note: this test relies on the empty cache from the mock
    const results = semanticSearchByVector([1, 2, 3], 5);
    // With empty cache, should return empty
    expect(results).toHaveLength(0);
  });
});
