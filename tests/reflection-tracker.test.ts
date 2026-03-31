import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({ pending: [] }),
  atomicWriteJSON: vi.fn(),
  ensureDir: vi.fn(),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
}));

import { trackSentMessage, resolveReflections, createReflectionNodes, getReflectionSummary } from "../backend/reflection-tracker.js";
import type { Observation } from "../backend/observer.js";

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    timestamp: Date.now(),
    sender: "TestUser",
    senderJid: "test@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    text: "",
    ...overrides,
  };
}

describe("trackSentMessage", () => {
  it("records a sent message without errors", () => {
    expect(() => {
      trackSentMessage("Hello!", "test@s.whatsapp.net", false, 8);
    }).not.toThrow();
  });
});

describe("resolveReflections", () => {
  it("returns empty when no pending reflections", () => {
    const results = resolveReflections([]);
    expect(results).toEqual([]);
  });
});

describe("createReflectionNodes", () => {
  it("creates reflection nodes from resolved reflections", () => {
    const mockGraph = {
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const reflections = [{
      reflection: {
        id: "ref_1",
        messageSent: "How are you doing?",
        targetJid: "test@s.whatsapp.net",
        sentAt: Date.now() - 3600_000,
        wasInitiative: true,
      },
      outcome: {
        gotResponse: true,
        responseTimeMs: 120_000,
        responsePositive: true,
        responseSnippet: "I'm good thanks!",
      },
    }];

    const created = createReflectionNodes(mockGraph, reflections);
    expect(created).toBe(1);
    expect(mockGraph.applyOperations).toHaveBeenCalled();

    // Check the operation includes correct tags
    const call = mockGraph.applyOperations.mock.calls[0][0][0];
    expect(call.op).toBe("add_node");
    expect(call.type).toBe("reflection");
    expect(call.tags).toContain("reflection");
    expect(call.tags).toContain("positive-outcome");
  });

  it("creates no-response reflection nodes", () => {
    const mockGraph = {
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
    } as any;

    const reflections = [{
      reflection: {
        id: "ref_2",
        messageSent: "Hey there!",
        targetJid: "test@s.whatsapp.net",
        sentAt: Date.now() - 86400_000,
        wasInitiative: true,
      },
      outcome: {
        gotResponse: false,
      },
    }];

    const created = createReflectionNodes(mockGraph, reflections);
    expect(created).toBe(1);

    const call = mockGraph.applyOperations.mock.calls[0][0][0];
    expect(call.tags).toContain("no-response");
  });
});

describe("getReflectionSummary", () => {
  it("returns empty when no reflections", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getReflectionSummary(mockGraph)).toBe("");
  });

  it("returns summary with recent reflections", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([{
        id: "r1",
        type: "reflection",
        content: "[reflection] Message: got response (5min, positive)",
        tags: ["reflection", "positive-outcome"],
        strength: 0.5,
        pinned: false,
        createdAt: Date.now() - 3600_000,
        lastAccessedAt: Date.now(),
        accessCount: 1,
      }]),
    } as any;

    const summary = getReflectionSummary(mockGraph);
    expect(summary).toContain("1 positive");
  });
});
