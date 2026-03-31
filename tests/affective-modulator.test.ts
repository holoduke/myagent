import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { assessCurrentAffect, getAffectiveModulationSummary } from "../backend/affective-modulator.js";
import type { MemoryNode } from "../backend/memory/types.js";

const now = Date.now();

function makeEmotionNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "em_test",
    type: "emotion",
    content: "Emotion signal",
    tags: ["emotion-signal"],
    strength: 0.5,
    pinned: false,
    createdAt: now - 3600_000, // 1 hour ago
    lastAccessedAt: now,
    accessCount: 1,
    emotionalValence: 0,
    ...overrides,
  };
}

describe("assessCurrentAffect", () => {
  it("returns null when no emotion nodes", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(assessCurrentAffect(mockGraph)).toBeNull();
  });

  it("returns null when emotions are too old", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ createdAt: now - 24 * 3600_000 }), // 24h ago, outside 6h window
      ]),
    } as any;

    expect(assessCurrentAffect(mockGraph)).toBeNull();
  });

  it("detects negative high-intensity state", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ id: "em1", emotionalValence: -0.8, strength: 0.9, tags: ["stress", "emotion-signal"] }),
        makeEmotionNode({ id: "em2", emotionalValence: -0.6, strength: 0.7, tags: ["stress", "emotion-signal"] }),
      ]),
    } as any;

    const profile = assessCurrentAffect(mockGraph);
    expect(profile).not.toBeNull();
    expect(profile!.valence).toBeLessThan(-0.3);
    expect(profile!.adaptations.increaseEmpathy).toBe(true);
    expect(profile!.adaptations.reduceProactivity).toBe(true);
    expect(profile!.adaptations.suggestedTone).toBe("supportive");
  });

  it("detects positive high-intensity state", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ id: "em1", emotionalValence: 0.8, strength: 0.9, tags: ["joy", "emotion-signal"] }),
        makeEmotionNode({ id: "em2", emotionalValence: 0.7, strength: 0.8, tags: ["joy", "emotion-signal"] }),
      ]),
    } as any;

    const profile = assessCurrentAffect(mockGraph);
    expect(profile).not.toBeNull();
    expect(profile!.valence).toBeGreaterThan(0.3);
    expect(profile!.adaptations.mirrorPositivity).toBe(true);
    expect(profile!.adaptations.suggestedTone).toBe("energetic");
  });

  it("returns neutral adaptations for neutral emotions", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ id: "em1", emotionalValence: 0.1, strength: 0.3, tags: ["calm", "emotion-signal"] }),
      ]),
    } as any;

    const profile = assessCurrentAffect(mockGraph);
    expect(profile).not.toBeNull();
    expect(profile!.adaptations.suggestedTone).toBe("neutral");
    expect(profile!.adaptations.increaseEmpathy).toBe(false);
    expect(profile!.adaptations.mirrorPositivity).toBe(false);
  });

  it("filters by targetJid when provided", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ id: "em1", emotionalValence: -0.8, strength: 0.9, tags: ["stress", "emotion-signal", "alice@s.whatsapp.net"] }),
        makeEmotionNode({ id: "em2", emotionalValence: 0.8, strength: 0.8, tags: ["joy", "emotion-signal", "bob@s.whatsapp.net"] }),
      ]),
    } as any;

    const profile = assessCurrentAffect(mockGraph, "alice@s.whatsapp.net");
    expect(profile).not.toBeNull();
    expect(profile!.valence).toBeLessThan(0); // Only Alice's stress
  });

  it("detects dominant emotion from tags", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ id: "em1", tags: ["gratitude", "emotion-signal"], emotionalValence: 0.5 }),
        makeEmotionNode({ id: "em2", tags: ["gratitude", "emotion-signal"], emotionalValence: 0.6 }),
        makeEmotionNode({ id: "em3", tags: ["excitement", "emotion-signal"], emotionalValence: 0.7 }),
      ]),
    } as any;

    const profile = assessCurrentAffect(mockGraph);
    expect(profile).not.toBeNull();
    expect(profile!.dominantEmotion).toBe("gratitude");
  });
});

describe("getAffectiveModulationSummary", () => {
  it("returns empty string when no emotions", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([]),
    } as any;

    expect(getAffectiveModulationSummary(mockGraph)).toBe("");
  });

  it("returns formatted summary with adaptations", () => {
    const mockGraph = {
      findByType: vi.fn().mockReturnValue([
        makeEmotionNode({ id: "em1", emotionalValence: -0.7, strength: 0.8, tags: ["stress", "emotion-signal"] }),
      ]),
    } as any;

    const summary = getAffectiveModulationSummary(mockGraph);
    expect(summary).toContain("Recent mood:");
    expect(summary).toContain("empathy");
  });
});
