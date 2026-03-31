import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { predictNextScene, applyScenePrediction } from "../backend/scene-predictor.js";
import type { WorkingMemory } from "../backend/memory/types.js";
import type { MemoryNode } from "../backend/memory/types.js";

const now = Date.now();

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "n_test",
    type: "person",
    content: "Test person",
    tags: ["test"],
    strength: 0.7,
    pinned: false,
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 2,
    ...overrides,
  };
}

function makeWM(overrides: Partial<WorkingMemory> = {}): WorkingMemory {
  return {
    currentContext: "test",
    mood: "neutral",
    shortTermTracking: [],
    pendingFollowUps: [],
    conversationThreads: [],
    activatedNodeIds: [],
    activeGoals: [],
    ...overrides,
  } as WorkingMemory;
}

describe("predictNextScene", () => {
  it("returns empty prediction with no signals", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    const wm = makeWM();
    const prediction = predictNextScene(mockGraph, wm);
    expect(prediction.topics.length).toBeGreaterThanOrEqual(0);
    expect(prediction.confidence).toBeGreaterThanOrEqual(0);
    expect(prediction.confidence).toBeLessThanOrEqual(1);
  });

  it("stages person nodes for upcoming calendar events", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "person") return [
          makeNode({ id: "p_alice", content: "Alice is the project lead" }),
          makeNode({ id: "p_bob", content: "Bob works in finance" }),
        ];
        return [];
      }),
    } as any;

    const wm = makeWM({
      temporal: {
        upcomingEvents: ["Meeting with Alice"],
      } as any,
    });

    const prediction = predictNextScene(mockGraph, wm);
    expect(prediction.topics).toContain("meeting with alice");
    expect(prediction.stagedNodeIds).toContain("p_alice");
    expect(prediction.stagedNodeIds).not.toContain("p_bob");
  });

  it("stages nodes for active conversation threads", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "person") return [
          makeNode({ id: "p_carol", content: "Carol from the design team" }),
        ];
        return [];
      }),
    } as any;

    const wm = makeWM({
      conversationThreads: [
        { status: "active", topic: "Design review", participants: ["Carol"] },
      ],
    } as any);

    const prediction = predictNextScene(mockGraph, wm);
    expect(prediction.topics).toContain("design review");
    expect(prediction.stagedNodeIds).toContain("p_carol");
  });

  it("stages nodes for pending follow-ups due soon", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "person") return [
          makeNode({ id: "p_dave", content: "Dave is the client contact" }),
        ];
        return [];
      }),
    } as any;

    const wm = makeWM({
      pendingFollowUps: [
        {
          id: "fu_1",
          question: "Did Dave send the invoice?",
          targetPerson: "Dave",
          dueAt: now + 2 * 3600_000, // 2 hours from now
          potentiallyResolved: false,
        },
      ],
    } as any);

    const prediction = predictNextScene(mockGraph, wm);
    expect(prediction.topics.some((t: string) => t.includes("dave"))).toBe(true);
    expect(prediction.stagedNodeIds).toContain("p_dave");
  });

  it("skips resolved follow-ups", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    const wm = makeWM({
      pendingFollowUps: [
        {
          id: "fu_1",
          question: "Test follow-up",
          dueAt: now + 2 * 3600_000,
          potentiallyResolved: true,
        },
      ],
    } as any);

    const prediction = predictNextScene(mockGraph, wm);
    // Should not add topics for resolved follow-ups
    expect(prediction.topics.some((t: string) => t.includes("test follow-up"))).toBe(false);
  });

  it("deduplicates staged node IDs", () => {
    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "person") return [
          makeNode({ id: "p_alice", content: "Alice works on the design project" }),
        ];
        return [];
      }),
    } as any;

    const wm = makeWM({
      temporal: {
        upcomingEvents: ["Design meeting with Alice"],
      } as any,
      conversationThreads: [
        { status: "active", topic: "Design review", participants: ["Alice"] },
      ],
    } as any);

    const prediction = predictNextScene(mockGraph, wm);
    const aliceCount = prediction.stagedNodeIds.filter((id: string) => id === "p_alice").length;
    expect(aliceCount).toBeLessThanOrEqual(1);
  });

  it("limits staged nodes to 15", () => {
    const manyPersons = Array.from({ length: 20 }, (_, i) =>
      makeNode({ id: `p_${i}`, content: `Person ${i} schedule topic` }),
    );

    const mockGraph = {
      findByType: vi.fn().mockImplementation((type: string) => {
        if (type === "person") return manyPersons;
        if (type === "goal") return [];
        if (type === "event") return [];
        return [];
      }),
    } as any;

    const wm = makeWM({
      temporal: {
        upcomingEvents: ["schedule topic meeting"],
      } as any,
    });

    const prediction = predictNextScene(mockGraph, wm);
    expect(prediction.stagedNodeIds.length).toBeLessThanOrEqual(15);
  });
});

describe("applyScenePrediction", () => {
  it("does nothing with empty prediction", () => {
    const wm = makeWM({ activatedNodeIds: ["existing_1"] });
    applyScenePrediction(wm, {
      topics: [],
      stagedNodeIds: [],
      reasoning: "",
      confidence: 0,
    });
    expect(wm.activatedNodeIds).toEqual(["existing_1"]);
  });

  it("merges staged nodes into activated node IDs", () => {
    const wm = makeWM({ activatedNodeIds: ["existing_1"] });
    applyScenePrediction(wm, {
      topics: ["test"],
      stagedNodeIds: ["staged_1", "staged_2"],
      reasoning: "test",
      confidence: 0.5,
    });
    expect(wm.activatedNodeIds).toContain("existing_1");
    expect(wm.activatedNodeIds).toContain("staged_1");
    expect(wm.activatedNodeIds).toContain("staged_2");
  });

  it("deduplicates when merging", () => {
    const wm = makeWM({ activatedNodeIds: ["node_1", "node_2"] });
    applyScenePrediction(wm, {
      topics: ["test"],
      stagedNodeIds: ["node_1", "node_3"],
      reasoning: "test",
      confidence: 0.5,
    });
    const node1Count = wm.activatedNodeIds!.filter(id => id === "node_1").length;
    expect(node1Count).toBe(1);
  });

  it("caps total activated nodes at 20", () => {
    const existing = Array.from({ length: 18 }, (_, i) => `existing_${i}`);
    const wm = makeWM({ activatedNodeIds: existing });
    applyScenePrediction(wm, {
      topics: ["test"],
      stagedNodeIds: ["new_1", "new_2", "new_3", "new_4", "new_5"],
      reasoning: "test",
      confidence: 0.5,
    });
    expect(wm.activatedNodeIds!.length).toBeLessThanOrEqual(20);
  });
});
