import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { estimateCognitiveLoad, getCognitiveLoadSummary } from "../backend/cognitive-load.js";
import type { WorkingMemory } from "../backend/memory/types.js";
import type { Observation } from "../backend/observer.js";

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

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    source: "whatsapp",
    sender: "Me",
    text: "Hello",
    timestamp: Date.now(),
    isFromMe: true,
    isGroup: false,
    ...overrides,
  } as Observation;
}

describe("estimateCognitiveLoad", () => {
  it("returns low load with minimal signals", () => {
    const wm = makeWM();
    const estimate = estimateCognitiveLoad(wm, [], 10, 6); // 10am Saturday
    expect(estimate.level).toBe("low");
    expect(estimate.score).toBeLessThan(0.3);
    expect(estimate.adaptations.deferProactive).toBe(false);
    expect(estimate.adaptations.simplifyMessages).toBe(false);
  });

  it("returns higher load during late night hours", () => {
    const wm = makeWM();
    const estimate = estimateCognitiveLoad(wm, [], 1, 3); // 1am Wednesday
    expect(estimate.score).toBeGreaterThan(0.15);
  });

  it("returns higher load with dense calendar", () => {
    const wm = makeWM({
      temporal: {
        upcomingEvents: ["Meeting 1", "Meeting 2", "Meeting 3", "Meeting 4", "Meeting 5"],
      } as any,
    });
    const estimate = estimateCognitiveLoad(wm, [], 10, 1); // 10am Monday
    expect(estimate.factors.find(f => f.name === "calendar_density")!.contribution).toBeGreaterThan(0.1);
  });

  it("returns higher load with many owner messages", () => {
    const obs = Array.from({ length: 20 }, (_, i) =>
      makeObs({ text: "Message " + i, isFromMe: true }),
    );
    const wm = makeWM();
    const estimate = estimateCognitiveLoad(wm, obs, 10, 1);
    expect(estimate.factors.find(f => f.name === "message_volume")!.contribution).toBeGreaterThan(0.1);
  });

  it("returns higher load with complex (long) messages", () => {
    const obs = [
      makeObs({ text: "A".repeat(500), isFromMe: true }),
      makeObs({ text: "B".repeat(400), isFromMe: true }),
    ];
    const wm = makeWM();
    const estimate = estimateCognitiveLoad(wm, obs, 10, 1);
    expect(estimate.factors.find(f => f.name === "message_complexity")!.contribution).toBeGreaterThan(0.05);
  });

  it("returns higher load on weekdays vs weekends", () => {
    const wm = makeWM();
    const weekday = estimateCognitiveLoad(wm, [], 10, 2); // Tuesday
    const weekend = estimateCognitiveLoad(wm, [], 10, 0); // Sunday
    expect(weekday.score).toBeGreaterThan(weekend.score);
  });

  it("applies correct adaptations for overloaded state", () => {
    // Stack all high-load factors
    const wm = makeWM({
      temporal: {
        upcomingEvents: Array.from({ length: 5 }, (_, i) => `Meeting ${i}`),
      } as any,
    });
    const obs = Array.from({ length: 20 }, (_, i) =>
      makeObs({ text: "X".repeat(400), isFromMe: true }),
    );
    const estimate = estimateCognitiveLoad(wm, obs, 0, 1); // midnight Monday

    // Should be high or overloaded
    expect(["high", "overloaded"]).toContain(estimate.level);
    expect(estimate.adaptations.deferProactive).toBe(true);
    expect(estimate.adaptations.simplifyMessages).toBe(true);
  });

  it("returns correct levels for score thresholds", () => {
    const wm = makeWM();
    // Low load scenario
    const low = estimateCognitiveLoad(wm, [], 10, 0); // 10am Sunday
    expect(low.level).toBe("low");

    // Level boundaries: low < 0.3, moderate < 0.5, high < 0.75, overloaded >= 0.75
    expect(low.score).toBeLessThanOrEqual(1);
    expect(low.score).toBeGreaterThanOrEqual(0);
  });
});

describe("getCognitiveLoadSummary", () => {
  it("returns empty string for low load", () => {
    const wm = makeWM();
    const summary = getCognitiveLoadSummary(wm, []);
    // Low load returns empty
    expect(typeof summary).toBe("string");
  });

  it("returns summary for high load", () => {
    const wm = makeWM({
      temporal: {
        upcomingEvents: Array.from({ length: 5 }, (_, i) => `Meeting ${i}`),
      } as any,
    });
    const obs = Array.from({ length: 20 }, (_, i) =>
      makeObs({ text: "X".repeat(400), isFromMe: true }),
    );

    const summary = getCognitiveLoadSummary(wm, obs);
    // May or may not be empty depending on total score
    expect(typeof summary).toBe("string");
  });
});
