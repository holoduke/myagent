import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

import { canTriggerInitiativeThink, recordInitiativeThink, formatInitiativeSignals } from "../backend/initiative.js";
import type { InitiativeSignal } from "../backend/initiative.js";
import type { BrainState } from "../backend/memory/types.js";
import { getOwnerLocalDate } from "../backend/brain-config.js";
import { getBrainConfig } from "../backend/brain-config.js";

function makeState(overrides: Partial<BrainState> = {}): BrainState {
  return {
    lastObserveTick: 0,
    lastThinkTick: 0,
    lastConsolidateTick: 0,
    lastReflectTick: 0,
    lastMessageTime: 0,
    messagesToday: 0,
    messagesTodayDate: "",
    lastObservationTime: 0,
    initiativeThinksToday: 0,
    initiativeBudgetDate: getOwnerLocalDate(getBrainConfig().ownerTimezone),
    ...overrides,
  } as BrainState;
}

// ── canTriggerInitiativeThink ──

describe("canTriggerInitiativeThink", () => {
  it("allows when no thinks have been used today", () => {
    const state = makeState({ initiativeThinksToday: 0 });
    expect(canTriggerInitiativeThink(state)).toBe(true);
  });

  it("allows up to 2 thinks (max is 3)", () => {
    const state = makeState({ initiativeThinksToday: 2 });
    expect(canTriggerInitiativeThink(state)).toBe(true);
  });

  it("blocks at 3 thinks (reached limit)", () => {
    const state = makeState({ initiativeThinksToday: 3 });
    expect(canTriggerInitiativeThink(state)).toBe(false);
  });

  it("blocks above limit", () => {
    const state = makeState({ initiativeThinksToday: 5 });
    expect(canTriggerInitiativeThink(state)).toBe(false);
  });

  it("resets counter on new day", () => {
    const state = makeState({
      initiativeThinksToday: 3,
      initiativeBudgetDate: "2024-01-01", // old date
    });
    expect(canTriggerInitiativeThink(state)).toBe(true);
    expect(state.initiativeThinksToday).toBe(0);
  });

  it("updates budget date on reset", () => {
    const state = makeState({
      initiativeThinksToday: 3,
      initiativeBudgetDate: "2024-01-01",
    });
    const today = getOwnerLocalDate(getBrainConfig().ownerTimezone);
    canTriggerInitiativeThink(state);
    expect(state.initiativeBudgetDate).toBe(today);
  });
});

// ── recordInitiativeThink ──

describe("recordInitiativeThink", () => {
  it("increments the counter", () => {
    const state = makeState({ initiativeThinksToday: 0 });
    recordInitiativeThink(state);
    expect(state.initiativeThinksToday).toBe(1);
  });

  it("increments from existing count", () => {
    const state = makeState({ initiativeThinksToday: 2 });
    recordInitiativeThink(state);
    expect(state.initiativeThinksToday).toBe(3);
  });

  it("increments multiple times", () => {
    const state = makeState({ initiativeThinksToday: 0 });
    recordInitiativeThink(state);
    recordInitiativeThink(state);
    recordInitiativeThink(state);
    expect(state.initiativeThinksToday).toBe(3);
  });
});

// ── formatInitiativeSignals ──

describe("formatInitiativeSignals", () => {
  it("returns empty string for no signals", () => {
    expect(formatInitiativeSignals([])).toBe("");
  });

  it("formats a HIGH priority signal", () => {
    const signals: InitiativeSignal[] = [{
      type: "goal_deadline",
      priority: 0.8,
      description: 'Goal "Ship v2" is overdue (75% complete)',
      relatedNodeIds: ["node-1"],
      suggestedAction: "Review overdue goal: Ship v2",
    }];
    const result = formatInitiativeSignals(signals);
    expect(result).toContain("[HIGH]");
    expect(result).toContain("Ship v2");
    expect(result).toContain("Suggested:");
    expect(result).toContain("INITIATIVE SIGNALS");
  });

  it("formats a MEDIUM priority signal", () => {
    const signals: InitiativeSignal[] = [{
      type: "person_absent",
      priority: 0.4,
      description: "Haven't heard from Alice in 10 days",
      relatedNodeIds: [],
    }];
    const result = formatInitiativeSignals(signals);
    expect(result).toContain("[MEDIUM]");
    expect(result).toContain("Alice");
  });

  it("formats a LOW priority signal", () => {
    const signals: InitiativeSignal[] = [{
      type: "conversation_stale",
      priority: 0.2,
      description: "Conversation about project went quiet",
      relatedNodeIds: [],
    }];
    const result = formatInitiativeSignals(signals);
    expect(result).toContain("[LOW]");
  });

  it("formats multiple signals", () => {
    const signals: InitiativeSignal[] = [
      { type: "goal_deadline", priority: 0.8, description: "Goal overdue", relatedNodeIds: [] },
      { type: "person_absent", priority: 0.4, description: "Person absent", relatedNodeIds: [] },
      { type: "conversation_stale", priority: 0.2, description: "Conv stale", relatedNodeIds: [] },
    ];
    const result = formatInitiativeSignals(signals);
    expect(result).toContain("[HIGH]");
    expect(result).toContain("[MEDIUM]");
    expect(result).toContain("[LOW]");
  });

  it("omits suggested action when not present", () => {
    const signals: InitiativeSignal[] = [{
      type: "person_absent",
      priority: 0.4,
      description: "Test signal",
      relatedNodeIds: [],
    }];
    const result = formatInitiativeSignals(signals);
    expect(result).not.toContain("Suggested:");
  });

  it("includes suggested action when present", () => {
    const signals: InitiativeSignal[] = [{
      type: "follow_up_due",
      priority: 0.7,
      description: "Follow-up due",
      relatedNodeIds: [],
      suggestedAction: "Ask about status",
    }];
    const result = formatInitiativeSignals(signals);
    expect(result).toContain("→ Suggested: Ask about status");
  });
});
