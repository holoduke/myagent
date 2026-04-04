/**
 * Tests for the structured digest template (Phase 6b).
 */

import { describe, it, expect, vi } from "vitest";

// Mock dependencies
vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: (_path: string, defaultValue: unknown) => defaultValue,
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

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({
    ownerTimezone: "Europe/Amsterdam",
    selfCritiqueEnabled: false,
    selfCritiqueThreshold: 6,
    activationSpreadFactor: 0.6,
    thinkCooldown: 3600000,
  }),
}));

// Mock cognitive modules that brain-prompt.ts imports
vi.mock("../backend/preference-learner.js", () => ({
  getPreferenceSummary: () => "",
}));

vi.mock("../backend/emotion-tracker.js", () => ({
  getEmotionContextSummary: () => "",
}));

vi.mock("../backend/reflection-tracker.js", () => ({
  getReflectionSummary: () => "",
}));

vi.mock("../backend/causal-tracker.js", () => ({
  getCausalContextSummary: () => "",
}));

vi.mock("../backend/belief-tracker.js", () => ({
  getBeliefSummary: () => "",
}));

vi.mock("../backend/scene-predictor.js", () => ({
  getScenePredictionSummary: () => "",
}));

vi.mock("../backend/affective-modulator.js", () => ({
  getAffectiveModulationSummary: () => "",
}));

vi.mock("../backend/cognitive-load.js", () => ({
  getCognitiveLoadSummary: () => "",
}));

vi.mock("../backend/autonomy.js", () => ({
  isActionPermitted: () => true,
  getAutonomySummary: () => "",
}));

import { formatDigestTemplate } from "../backend/brain-prompt.js";
import type { WorkingMemory, TemporalContext } from "../backend/memory/types.js";
import type { MemoryGraph } from "../backend/memory/graph.js";
import type { MemoryNode } from "../backend/memory/types.js";

function makeTemporal(overrides: Partial<TemporalContext> = {}): TemporalContext {
  return {
    dayOfWeek: "Monday",
    timeOfDay: "morning",
    hour: 8,
    date: "2026-04-04",
    isWeekend: false,
    upcomingEvents: [],
    ...overrides,
  };
}

function makeWm(overrides: Partial<WorkingMemory> = {}): WorkingMemory {
  return {
    currentContext: "",
    mood: "neutral",
    shortTermTracking: [],
    activatedNodeIds: [],
    activeGoals: [],
    pendingFollowUps: [],
    conversationThreads: [],
    temporal: makeTemporal(),
    ...overrides,
  };
}

function makeGraph(nodes: Partial<MemoryNode>[] = []): MemoryGraph {
  return {
    findByType: (type: string) =>
      nodes.filter(n => n.type === type).map(n => ({
        id: n.id ?? `n_${Math.random().toString(36).slice(2, 8)}`,
        type: n.type ?? "fact",
        content: n.content ?? "",
        tags: n.tags ?? [],
        strength: n.strength ?? 0.5,
        createdAt: n.createdAt ?? Date.now(),
        lastAccessedAt: n.lastAccessedAt ?? Date.now(),
        accessCount: n.accessCount ?? 0,
        pinned: n.pinned ?? false,
        importance: n.importance ?? 0,
        emotionalValence: n.emotionalValence ?? 0,
        confidence: n.confidence ?? 0.5,
        uselessRetrievalCount: n.uselessRetrievalCount ?? 0,
      })) as MemoryNode[],
  } as unknown as MemoryGraph;
}

describe("formatDigestTemplate", () => {
  it("returns empty string when no content and not in digest window", () => {
    const wm = makeWm({ temporal: makeTemporal({ timeOfDay: "afternoon" }) });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toBe("");
  });

  it("returns empty string in morning window when no content available", () => {
    const wm = makeWm({ temporal: makeTemporal({ timeOfDay: "morning" }) });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    // In digest window but no sections have content
    expect(result).toBe("");
  });

  it("includes Calendar section when events exist in digest window", () => {
    const wm = makeWm({
      temporal: makeTemporal({
        timeOfDay: "morning",
        upcomingEvents: ["Meeting with Team at 10:00", "Lunch with Sarah at 12:30"],
      }),
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Calendar**");
    expect(result).toContain("Meeting with Team at 10:00");
    expect(result).toContain("Lunch with Sarah at 12:30");
  });

  it("includes Calendar even outside digest window when events exist", () => {
    const wm = makeWm({
      temporal: makeTemporal({
        timeOfDay: "afternoon",
        upcomingEvents: ["Urgent meeting at 15:00"],
      }),
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Calendar**");
    expect(result).toContain("Urgent meeting at 15:00");
  });

  it("includes Follow-ups section when due", () => {
    const wm = makeWm({
      temporal: makeTemporal({ timeOfDay: "morning" }),
      pendingFollowUps: [
        {
          id: "fu_1",
          question: "Did you get the report?",
          targetPerson: "Alice",
          context: "work report",
          createdAt: Date.now() - 86400000,
          dueAt: Date.now() - 3600000, // overdue
        },
      ],
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Follow-ups**");
    expect(result).toContain("[Alice]");
    expect(result).toContain("Did you get the report?");
  });

  it("triggers outside digest window when follow-ups are overdue", () => {
    const wm = makeWm({
      temporal: makeTemporal({ timeOfDay: "afternoon" }),
      pendingFollowUps: [
        {
          id: "fu_1",
          question: "Overdue item",
          context: "test",
          createdAt: Date.now() - 86400000,
          dueAt: Date.now() - 3600000, // overdue
        },
      ],
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Follow-ups**");
    expect(result).toContain("Overdue item");
  });

  it("excludes resolved follow-ups", () => {
    const wm = makeWm({
      temporal: makeTemporal({ timeOfDay: "morning" }),
      pendingFollowUps: [
        {
          id: "fu_1",
          question: "Resolved item",
          context: "test",
          createdAt: Date.now(),
          potentiallyResolved: true,
        },
      ],
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).not.toContain("Resolved item");
  });

  it("includes People section when strong person nodes exist", () => {
    const graph = makeGraph([
      {
        type: "person",
        content: "Sarah — close friend, works at Google",
        strength: 0.8,
        lastAccessedAt: Date.now() - 3600000,
      },
    ]);
    const wm = makeWm({ temporal: makeTemporal({ timeOfDay: "evening" }) });
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**People**");
    expect(result).toContain("Sarah");
  });

  it("excludes weak person nodes (strength <= 0.3)", () => {
    const graph = makeGraph([
      {
        type: "person",
        content: "Weak contact",
        strength: 0.2,
      },
    ]);
    const wm = makeWm({ temporal: makeTemporal({ timeOfDay: "morning" }) });
    const result = formatDigestTemplate(wm, graph);
    expect(result).not.toContain("Weak contact");
  });

  it("includes Recent Insights section in evening window", () => {
    const graph = makeGraph([
      {
        type: "insight",
        content: "Owner tends to be more productive in the morning",
        createdAt: Date.now() - 86400000, // 1 day ago
      },
    ]);
    const wm = makeWm({ temporal: makeTemporal({ timeOfDay: "evening" }) });
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Recent Insights**");
    expect(result).toContain("Owner tends to be more productive");
  });

  it("excludes old insights (> 7 days)", () => {
    const graph = makeGraph([
      {
        type: "insight",
        content: "Old insight from weeks ago",
        createdAt: Date.now() - 14 * 86400000, // 14 days ago
      },
    ]);
    const wm = makeWm({ temporal: makeTemporal({ timeOfDay: "morning" }) });
    const result = formatDigestTemplate(wm, graph);
    expect(result).not.toContain("Old insight");
  });

  it("includes Active Goals section", () => {
    const wm = makeWm({
      temporal: makeTemporal({ timeOfDay: "morning" }),
      activeGoals: [
        {
          nodeId: "g_1",
          title: "Finish quarterly review",
          priority: 1 as const,
          progress: 0.6,
          deadlineStatus: "approaching" as const,
        },
      ],
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Active Goals**");
    expect(result).toContain("Finish quarterly review");
    expect(result).toContain("approaching");
  });

  it("contains DIGEST TEMPLATE header", () => {
    const wm = makeWm({
      temporal: makeTemporal({
        timeOfDay: "morning",
        upcomingEvents: ["Test event"],
      }),
    });
    const graph = makeGraph();
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("═══ DIGEST TEMPLATE ═══");
  });

  it("combines multiple sections", () => {
    const wm = makeWm({
      temporal: makeTemporal({
        timeOfDay: "evening",
        upcomingEvents: ["Board meeting at 9:00"],
      }),
      activeGoals: [
        {
          nodeId: "g_1",
          title: "Ship v2.0",
          priority: 1 as const,
          progress: 0.8,
          deadlineStatus: "on_track" as const,
        },
      ],
    });
    const graph = makeGraph([
      {
        type: "person",
        content: "Mike — CTO",
        strength: 0.9,
        lastAccessedAt: Date.now(),
      },
    ]);
    const result = formatDigestTemplate(wm, graph);
    expect(result).toContain("**Calendar**");
    expect(result).toContain("**People**");
    expect(result).toContain("**Active Goals**");
  });
});
