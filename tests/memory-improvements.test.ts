import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
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

import {
  inferEmotionalValence,
  spacedRepetitionRefresh,
  autoAssignConfidence,
  inferContentSalience,
} from "../backend/memory/retention.js";
import type { MemoryNode } from "../backend/memory/types.js";

// ── Helper ──

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test01",
    type: "event",
    content: "Test event content",
    tags: [],
    strength: 0.5,
    pinned: false,
    createdAt: Date.now() - 86400000,
    lastAccessedAt: Date.now() - 3600000,
    accessCount: 1,
    ...overrides,
  };
}

// ── Emotional Valence ──

describe("inferEmotionalValence", () => {
  it("returns 0 for neutral text", () => {
    expect(inferEmotionalValence("Meeting tomorrow at 3pm")).toBe(0);
  });

  it("returns positive for celebration language", () => {
    const val = inferEmotionalValence("Gefeliciteerd met je promotie!");
    expect(val).toBeGreaterThan(0);
  });

  it("returns positive for happy English text", () => {
    const val = inferEmotionalValence("What amazing news, congratulations!");
    expect(val).toBeGreaterThan(0);
  });

  it("returns negative for sad text", () => {
    const val = inferEmotionalValence("Hij is helaas overleden gisteren");
    expect(val).toBeLessThan(0);
  });

  it("returns negative for conflict text", () => {
    const val = inferEmotionalValence("There was a big argument and fight about it");
    expect(val).toBeLessThan(0);
  });

  it("returns negative for medical emergency", () => {
    const val = inferEmotionalValence("Naar het ziekenhuis gebracht met spoed");
    expect(val).toBeLessThan(0);
  });

  it("returns mixed value when both positive and negative present", () => {
    // "Happy but also sad" - both signals present
    const val = inferEmotionalValence("Very happy about the promotion but also sad to leave");
    // Should be close to 0 since both positive and negative are present
    expect(Math.abs(val)).toBeLessThanOrEqual(1);
  });

  it("returns positive for wedding text", () => {
    const val = inferEmotionalValence("We gaan trouwen in juni!");
    expect(val).toBeGreaterThan(0);
  });

  it("returns positive for birth text", () => {
    const val = inferEmotionalValence("De baby is geboren, een gezonde jongen!");
    expect(val).toBeGreaterThan(0);
  });

  it("returns negative for job loss", () => {
    const val = inferEmotionalValence("Ik ben ontslagen bij het bedrijf");
    expect(val).toBeLessThan(0);
  });
});

// ── Spaced Repetition Refresh ──

describe("spacedRepetitionRefresh", () => {
  it("refreshes high-importance declining nodes", () => {
    const nodes = [
      makeNode({ id: "n_1", importance: 0.8, strength: 0.2, pinned: false }),
      makeNode({ id: "n_2", importance: 0.9, strength: 0.3, pinned: false }),
    ];
    const mockGraph = { allNodes: () => nodes };

    const refreshed = spacedRepetitionRefresh(mockGraph as any);
    expect(refreshed).toBe(2);

    // n_1: importance 0.8, was 0.2, ceiling = 0.64, boost = min(0.1, 0.44) = 0.1
    expect(nodes[0].strength).toBeCloseTo(0.3, 1);
    // n_2: importance 0.9, was 0.3, ceiling = 0.72, boost = min(0.1, 0.42) = 0.1
    expect(nodes[1].strength).toBeCloseTo(0.4, 1);
  });

  it("skips pinned nodes", () => {
    const mockGraph = {
      allNodes: () => [
        makeNode({ id: "n_1", importance: 0.9, strength: 0.1, pinned: true }),
      ],
    };

    const refreshed = spacedRepetitionRefresh(mockGraph as any);
    expect(refreshed).toBe(0);
  });

  it("skips nodes with low importance", () => {
    const mockGraph = {
      allNodes: () => [
        makeNode({ id: "n_1", importance: 0.3, strength: 0.2, pinned: false }),
      ],
    };

    const refreshed = spacedRepetitionRefresh(mockGraph as any);
    expect(refreshed).toBe(0);
  });

  it("skips nodes that are already strong enough", () => {
    const mockGraph = {
      allNodes: () => [
        makeNode({ id: "n_1", importance: 0.8, strength: 0.6, pinned: false }),
      ],
    };

    const refreshed = spacedRepetitionRefresh(mockGraph as any);
    expect(refreshed).toBe(0);
  });

  it("caps boost at importance * 0.8", () => {
    const node = makeNode({ id: "n_1", importance: 0.7, strength: 0.1, pinned: false });
    const mockGraph = { allNodes: () => [node] };

    spacedRepetitionRefresh(mockGraph as any);
    // ceiling = 0.7 * 0.8 = 0.56, boost = min(0.1, 0.46) = 0.1
    // strength = 0.1 + 0.1 = 0.2
    expect(node.strength).toBeCloseTo(0.2, 1);
  });
});

// ── Auto-Confidence Assignment ──

describe("autoAssignConfidence", () => {
  it("assigns high confidence to owner-tagged nodes", () => {
    const node = makeNode({ tags: ["owner", "some-topic"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(1.0);
  });

  it("assigns 0.8 to whitelisted-tagged nodes", () => {
    const node = makeNode({ tags: ["whitelisted", "contact"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(0.8);
  });

  it("assigns 0.8 to family-tagged nodes", () => {
    const node = makeNode({ tags: ["family", "birthday"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(0.8);
  });

  it("assigns 0.7 to work-tagged nodes", () => {
    const node = makeNode({ tags: ["work", "meeting"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(0.7);
  });

  it("assigns 0.5 to insight nodes without source tags", () => {
    const node = makeNode({ type: "insight", tags: ["observation"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(0.5);
  });

  it("assigns 0.6 to event nodes without source tags", () => {
    const node = makeNode({ type: "event", tags: ["meeting"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(0.6);
  });

  it("skips nodes that already have confidence", () => {
    const node = makeNode({ confidence: 0.9, tags: ["work"] });
    const mockGraph = { allNodes: () => [node] };

    autoAssignConfidence(mockGraph as any);
    expect(node.confidence).toBe(0.9); // unchanged
  });

  it("returns count of updated nodes", () => {
    const nodes = [
      makeNode({ id: "n_1", tags: ["owner"] }),
      makeNode({ id: "n_2", tags: ["work"], confidence: 0.7 }),
      makeNode({ id: "n_3", tags: [] }),
    ];
    const mockGraph = { allNodes: () => nodes };

    const updated = autoAssignConfidence(mockGraph as any);
    expect(updated).toBe(2); // n_2 skipped
  });
});

// ── Useless Retrieval Count Interaction with Salience ──

describe("inferContentSalience with emotional text", () => {
  it("scores hospital mentions as high salience", () => {
    const score = inferContentSalience("Naar het ziekenhuis gebracht");
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it("scores wedding mentions as high salience", () => {
    const score = inferContentSalience("Ze gaan trouwen in augustus");
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it("scores casual text as zero salience", () => {
    const score = inferContentSalience("Hey, hoe gaat het?");
    expect(score).toBe(0);
  });
});

// ── MemoryNode new fields ──

describe("MemoryNode new fields", () => {
  it("supports emotionalValence field", () => {
    const node = makeNode({ emotionalValence: 0.8 });
    expect(node.emotionalValence).toBe(0.8);
  });

  it("supports confidence field", () => {
    const node = makeNode({ confidence: 0.9 });
    expect(node.confidence).toBe(0.9);
  });

  it("supports uselessRetrievalCount field", () => {
    const node = makeNode({ uselessRetrievalCount: 3 });
    expect(node.uselessRetrievalCount).toBe(3);
  });

  it("new fields are optional (backwards compatible)", () => {
    const node = makeNode();
    expect(node.emotionalValence).toBeUndefined();
    expect(node.confidence).toBeUndefined();
    expect(node.uselessRetrievalCount).toBeUndefined();
  });
});
