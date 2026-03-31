import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock("../backend/memory/embeddings.js", () => ({
  embedNode: vi.fn().mockResolvedValue(null),
}));

import { extractEmotionSignals, recordEmotionSignals, getEmotionContextSummary } from "../backend/emotion-tracker.js";
import type { Observation } from "../backend/observer.js";

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    timestamp: Date.now(),
    sender: "Alice",
    senderJid: "alice@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    text: "",
    ...overrides,
  };
}

describe("extractEmotionSignals", () => {
  it("returns empty for no observations", () => {
    expect(extractEmotionSignals([])).toEqual([]);
  });

  it("returns empty for short text", () => {
    const obs = [makeObs({ text: "hi" })];
    expect(extractEmotionSignals(obs)).toEqual([]);
  });

  it("detects positive emotions", () => {
    const obs = [makeObs({ text: "I'm so happy about this amazing news!" })];
    const signals = extractEmotionSignals(obs);
    expect(signals.length).toBe(1);
    expect(signals[0].valence).toBeGreaterThan(0);
    expect(signals[0].sender).toBe("Alice");
  });

  it("detects negative emotions", () => {
    const obs = [makeObs({ text: "I'm really frustrated and angry about this situation" })];
    const signals = extractEmotionSignals(obs);
    expect(signals.length).toBe(1);
    expect(signals[0].valence).toBeLessThan(0);
  });

  it("detects Dutch emotions", () => {
    const obs = [makeObs({ text: "Ik ben zo blij met dit resultaat!" })];
    const signals = extractEmotionSignals(obs);
    expect(signals.length).toBe(1);
    expect(signals[0].emotion).toBe("joy");
  });

  it("detects emoji emotions", () => {
    const obs = [makeObs({ text: "Look at this photo 😍😍" })];
    const signals = extractEmotionSignals(obs);
    expect(signals.length).toBe(1);
    expect(signals[0].valence).toBeGreaterThan(0);
  });

  it("takes strongest signal per observation", () => {
    const obs = [makeObs({ text: "I'm angry but also devastated by this terrible news" })];
    const signals = extractEmotionSignals(obs);
    expect(signals.length).toBe(1);
    expect(signals[0].intensity).toBeGreaterThanOrEqual(0.7);
  });

  it("handles multiple observations", () => {
    const obs = [
      makeObs({ text: "I'm so happy today!", sender: "Alice", senderJid: "a@s.whatsapp.net" }),
      makeObs({ text: "This is terrible news", sender: "Bob", senderJid: "b@s.whatsapp.net" }),
    ];
    const signals = extractEmotionSignals(obs);
    expect(signals.length).toBe(2);
  });
});

describe("recordEmotionSignals", () => {
  it("creates emotion nodes from signals", () => {
    const mockGraph = {
      applyOperations: vi.fn().mockReturnValue({ applied: 1, skipped: 0 }),
      updateNode: vi.fn(),
      getNode: vi.fn().mockReturnValue({
        id: "test",
        emotionalValence: 0,
        type: "emotion",
        content: "",
        tags: [],
        strength: 0.5,
        pinned: false,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        accessCount: 1,
      }),
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    const signals = [{
      emotion: "joy",
      intensity: 0.8,
      valence: 0.9,
      evidence: "I'm so happy!",
      sender: "Alice",
      senderJid: "alice@s.whatsapp.net",
    }];

    const created = recordEmotionSignals(mockGraph, signals);
    expect(created).toBe(1);
    expect(mockGraph.applyOperations).toHaveBeenCalled();
  });
});

describe("getEmotionContextSummary", () => {
  it("returns empty for no emotions", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getEmotionContextSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary for recent emotions", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([{
        id: "e1",
        type: "emotion",
        content: "[joy] Alice: \"Great news!\"",
        tags: ["joy"],
        strength: 0.8,
        pinned: false,
        createdAt: Date.now() - 3600_000,
        lastAccessedAt: Date.now(),
        accessCount: 1,
        emotionalValence: 0.9,
      }]),
    } as any;

    const summary = getEmotionContextSummary(mockGraph);
    expect(summary).toContain("positive");
  });
});
