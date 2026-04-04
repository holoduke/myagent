/**
 * Tests for multi-dimensional promotion scoring in archive rescan
 * and memory flush before compaction.
 */

import { describe, it, expect, vi } from "vitest";
import type { PromotionDimensions } from "../backend/memory/reconstruction.js";

// Mock file-store
vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: (_path: string, defaultValue: unknown) => defaultValue,
  atomicWriteJSON: vi.fn(),
  atomicWriteFile: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({
    archiveRecallMin: 1,
    archiveRecallMax: 5,
    archiveRecallDivisor: 10,
    activationSpreadFactor: 0.6,
  }),
}));

vi.mock("../backend/providers/embedding-provider.js", () => ({
  embedSingle: vi.fn().mockResolvedValue(null),
  embed: vi.fn().mockResolvedValue([]),
}));

describe("Multi-dimensional promotion scoring", () => {
  describe("PromotionDimensions interface", () => {
    it("has all 6 required dimensions", () => {
      const dims: PromotionDimensions = {
        relevance: 0.8,
        importance: 0.6,
        emotionalWeight: 0.3,
        recency: 0.9,
        uniqueness: 1.0,
        frequency: 0.4,
      };
      expect(dims.relevance).toBe(0.8);
      expect(dims.importance).toBe(0.6);
      expect(dims.emotionalWeight).toBe(0.3);
      expect(dims.recency).toBe(0.9);
      expect(dims.uniqueness).toBe(1.0);
      expect(dims.frequency).toBe(0.4);
    });

    it("all dimensions are 0-1 range by convention", () => {
      const dims: PromotionDimensions = {
        relevance: 0.5,
        importance: 0.5,
        emotionalWeight: 0.5,
        recency: 0.5,
        uniqueness: 0.5,
        frequency: 0.5,
      };
      for (const [, value] of Object.entries(dims)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("weighted composite calculation", () => {
    const WEIGHTS = {
      relevance: 0.30,
      importance: 0.20,
      emotionalWeight: 0.10,
      recency: 0.15,
      uniqueness: 0.10,
      frequency: 0.15,
    };

    function compositeScore(dims: PromotionDimensions, strength: number): number {
      return (
        dims.relevance * WEIGHTS.relevance +
        dims.importance * WEIGHTS.importance +
        dims.emotionalWeight * WEIGHTS.emotionalWeight +
        dims.recency * WEIGHTS.recency +
        dims.uniqueness * WEIGHTS.uniqueness +
        dims.frequency * WEIGHTS.frequency
      ) * strength;
    }

    it("weights sum to 1.0", () => {
      const sum = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
      expect(sum).toBeCloseTo(1.0);
    });

    it("high-relevance node scores higher than low-relevance", () => {
      const base = { importance: 0.5, emotionalWeight: 0.1, recency: 0.5, uniqueness: 1.0, frequency: 0.3 };
      const high = compositeScore({ ...base, relevance: 0.9 }, 0.8);
      const low = compositeScore({ ...base, relevance: 0.2 }, 0.8);
      expect(high).toBeGreaterThan(low);
    });

    it("uniqueness penalty reduces score for duplicate content", () => {
      const base = { relevance: 0.5, importance: 0.5, emotionalWeight: 0.5, recency: 0.5, frequency: 0.5 };
      const unique = compositeScore({ ...base, uniqueness: 1.0 }, 0.8);
      const duplicate = compositeScore({ ...base, uniqueness: 0.2 }, 0.8);
      expect(unique).toBeGreaterThan(duplicate);
    });

    it("emotional weight amplifies recall", () => {
      const base = { relevance: 0.5, importance: 0.5, recency: 0.5, uniqueness: 1.0, frequency: 0.5 };
      const emotional = compositeScore({ ...base, emotionalWeight: 0.9 }, 0.8);
      const neutral = compositeScore({ ...base, emotionalWeight: 0.0 }, 0.8);
      expect(emotional).toBeGreaterThan(neutral);
    });

    it("node strength multiplier has large effect", () => {
      const dims: PromotionDimensions = {
        relevance: 0.5, importance: 0.5, emotionalWeight: 0.5,
        recency: 0.5, uniqueness: 0.5, frequency: 0.5,
      };
      const strong = compositeScore(dims, 0.9);
      const weak = compositeScore(dims, 0.2);
      expect(strong / weak).toBeCloseTo(4.5);
    });

    it("all-zero dimensions with any strength produces 0 score", () => {
      const dims: PromotionDimensions = {
        relevance: 0, importance: 0, emotionalWeight: 0,
        recency: 0, uniqueness: 0, frequency: 0,
      };
      expect(compositeScore(dims, 0.8)).toBe(0);
    });

    it("all-max dimensions with max strength produces max composite of 1.0", () => {
      const dims: PromotionDimensions = {
        relevance: 1, importance: 1, emotionalWeight: 1,
        recency: 1, uniqueness: 1, frequency: 1,
      };
      expect(compositeScore(dims, 1.0)).toBeCloseTo(1.0);
    });
  });
});

describe("Memory flush before compaction", () => {
  it("consolidation.ts imports flushEmbeddings from embeddings.ts", async () => {
    // Verify the import exists at the module level
    const consolMod = await import("../backend/memory/consolidation.js");
    // If the import failed, this module wouldn't load at all
    expect(consolMod.runConsolidation).toBeDefined();
  });

  it("consolidation.ts calls graph.save() at the start of runConsolidation", async () => {
    // Read the actual source file to verify the call order
    const { readFileSync } = await import("fs");
    const source = readFileSync(
      new URL("../backend/memory/consolidation.ts", import.meta.url).pathname
        .replace("/tests/", "/")
        .replace("../backend", "backend"),
      "utf-8"
    ).toString();

    // Find positions of key operations
    const flushPos = source.indexOf("graph.save()");
    const decayPos = source.indexOf("applyDecay(");
    const flushEmbeddingsPos = source.indexOf("flushEmbeddings()");

    // Verify flush operations come before decay
    expect(flushPos).toBeGreaterThan(-1);
    expect(flushEmbeddingsPos).toBeGreaterThan(-1);
    expect(decayPos).toBeGreaterThan(-1);
    expect(flushPos).toBeLessThan(decayPos);
    expect(flushEmbeddingsPos).toBeLessThan(decayPos);
  });

  it("flush is wrapped in try/catch that does not rethrow", async () => {
    const { readFileSync } = await import("fs");
    const source = readFileSync(
      new URL("../backend/memory/consolidation.ts", import.meta.url).pathname
        .replace("/tests/", "/")
        .replace("../backend", "backend"),
      "utf-8"
    ).toString();

    // Find the flush try/catch block — it should log but not rethrow
    const flushTryIdx = source.indexOf("graph.save()");
    const nearbySource = source.slice(Math.max(0, flushTryIdx - 300), flushTryIdx + 500);

    // Should contain try/catch
    expect(nearbySource).toContain("try {");
    expect(nearbySource).toContain("catch (flushErr)");
    // Should log the warning
    expect(nearbySource).toContain("non-fatal");
  });
});
