import { describe, it, expect } from "vitest";
import {
  extractKeywordsFromText,
  tokenJaccard,
  tokenOverlap,
  tagJaccard,
  tagOverlapCount,
  clusterByTagOverlap,
  CORRELATION_NOISE_WORDS,
} from "../../backend/memory/text-utils.js";
import type { MemoryNode } from "../../backend/memory/types.js";

function node(id: string, tags: string[]): MemoryNode {
  return { id, type: "fact", content: id, tags, strength: 0.2, pinned: false, createdAt: 0, lastAccessedAt: 0, accessCount: 0 };
}

describe("extractKeywordsFromText", () => {
  it("drops stop words, short words and pure numbers", () => {
    expect(extractKeywordsFromText("The 2024 meeting at 10 was about deadlines")).toEqual(["meeting", "deadlines"]);
  });

  it("applies extra stop words when given", () => {
    expect(extractKeywordsFromText("Gillis confirmed the deploy via WhatsApp", CORRELATION_NOISE_WORDS)).toEqual(["deploy"]);
    expect(extractKeywordsFromText("Gillis confirmed the deploy via WhatsApp")).toContain("gillis");
  });
});

describe("token similarity", () => {
  it("tokenJaccard is 1 for identical, 0 for disjoint, symmetric otherwise", () => {
    expect(tokenJaccard("a b c", "a b c")).toBe(1);
    expect(tokenJaccard("", "")).toBe(1);
    expect(tokenJaccard("alpha beta", "gamma delta")).toBe(0);
    expect(tokenJaccard("alpha beta gamma", "alpha beta")).toBeCloseTo(2 / 3);
    expect(tokenJaccard("alpha beta", "alpha beta gamma")).toBeCloseTo(2 / 3);
  });

  it("tokenOverlap divides by the larger set and ignores 1-2 char tokens", () => {
    expect(tokenOverlap("lucas plays football", "lucas plays football on sunday evenings")).toBeCloseTo(3 / 5);
    expect(tokenOverlap("", "x")).toBe(0);
  });
});

describe("tag helpers", () => {
  it("are case-insensitive", () => {
    expect(tagOverlapCount(["Work", "Family"], ["work", "friend"])).toBe(1);
    expect(tagJaccard(["A", "b"], ["a", "B"])).toBe(1);
    expect(tagJaccard([], [])).toBe(1);
    expect(tagJaccard(["a"], [])).toBe(0);
  });
});

describe("clusterByTagOverlap", () => {
  it("groups nodes sharing >= minSharedTags with the seed and reports tags shared by all", () => {
    const clusters = clusterByTagOverlap([
      node("a", ["alice", "project", "work"]),
      node("b", ["alice", "project", "meeting"]),
      node("c", ["alice", "project", "deadline"]),
      node("d", ["bob", "golf"]),
    ]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].nodes.map(n => n.id)).toEqual(["a", "b", "c"]);
    expect(clusters[0].sharedTags.sort()).toEqual(["alice", "project"]);
  });

  it("respects minClusterSize, maxClusterSize and maxClusters, and never reuses a node", () => {
    const nodes = [
      ...["a", "b", "c", "d"].map(id => node(id, ["x", "y"])),
      ...["e", "f", "g"].map(id => node(id, ["p", "q"])),
      node("h", ["lonely", "tag"]),
    ];
    const clusters = clusterByTagOverlap(nodes, { maxClusterSize: 3, maxClusters: 1 });
    expect(clusters.length).toBe(1);
    expect(clusters[0].nodes.length).toBe(3);

    const all = clusterByTagOverlap(nodes);
    const ids = all.flatMap(c => c.nodes.map(n => n.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.length).toBe(2);
  });
});
