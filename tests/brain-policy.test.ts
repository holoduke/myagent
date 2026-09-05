import { describe, it, expect } from "vitest";
import {
  decideTickKind,
  computeBackoffMs,
  tickTimeoutFor,
  LLM_TIMEOUT_MS,
  TICK_TIMEOUT_MARGIN_MS,
} from "../backend/brain-policy.js";
import type { TickDecisionInput } from "../backend/brain-policy.js";

const HOUR = 3600_000;
const MIN = 60_000;
const NOW = 1_000 * HOUR;

function input(overrides: Partial<TickDecisionInput> = {}): TickDecisionInput {
  return {
    now: NOW,
    lastThinkTick: NOW - 10 * MIN,
    lastConsolidateTick: NOW - 1 * HOUR,
    lastReflectTick: NOW - 2 * HOUR,
    thinkCooldown: 2 * HOUR,
    consolidateInterval: 8 * HOUR,
    reflectInterval: 12 * HOUR,
    timeAwarenessInterval: 4 * HOUR,
    nodeCount: 10,
    hasPending: false,
    hasTriggerPending: false,
    pendingUrgency: 0,
    urgencyBypassThreshold: 0.6,
    urgencyMinCooldown: 5 * MIN,
    pendingInterrupt: false,
    initiativeTriggered: false,
    ...overrides,
  };
}

describe("tickTimeoutFor", () => {
  it("exceeds the LLM timeout by the margin for every tick kind", () => {
    expect(tickTimeoutFor("think")).toBe(330_000);
    expect(tickTimeoutFor("consolidate")).toBe(330_000);
    expect(tickTimeoutFor("reflect")).toBe(630_000);
    for (const kind of ["think", "consolidate", "reflect"] as const) {
      expect(tickTimeoutFor(kind)).toBe(LLM_TIMEOUT_MS[kind] + TICK_TIMEOUT_MARGIN_MS);
    }
  });

  it("lets the env override raise but never lower the budget", () => {
    expect(tickTimeoutFor("think", 120_000)).toBe(330_000);
    expect(tickTimeoutFor("think", 900_000)).toBe(900_000);
  });
});

describe("computeBackoffMs", () => {
  it("doubles per failure and clamps at the max", () => {
    expect(computeBackoffMs(3, MIN, 30 * MIN)).toBe(8 * MIN);
    expect(computeBackoffMs(10, MIN, 30 * MIN)).toBe(30 * MIN);
    expect(computeBackoffMs(1000, MIN, 30 * MIN)).toBe(30 * MIN);
  });
});

describe("decideTickKind", () => {
  it("does nothing when nothing is due", () => {
    expect(decideTickKind(input()).kind).toBeNull();
  });

  it("prefers reflect over consolidate over think", () => {
    const due = input({ lastReflectTick: NOW - 13 * HOUR, lastConsolidateTick: NOW - 9 * HOUR, hasPending: true, lastThinkTick: NOW - 3 * HOUR });
    expect(decideTickKind(due).kind).toBe("reflect");
    expect(decideTickKind({ ...due, lastReflectTick: NOW }).kind).toBe("consolidate");
    expect(decideTickKind({ ...due, lastReflectTick: NOW, lastConsolidateTick: NOW }).kind).toBe("think");
  });

  it("skips reflect/consolidate on an empty graph", () => {
    expect(decideTickKind(input({ nodeCount: 0, lastReflectTick: 0, lastConsolidateTick: 0 })).kind).toBeNull();
  });

  it("thinks on pending observations only once the cooldown elapsed", () => {
    expect(decideTickKind(input({ hasPending: true })).kind).toBeNull();
    expect(decideTickKind(input({ hasPending: true, lastThinkTick: NOW - 2 * HOUR })).kind).toBe("think");
  });

  it("a recurring/digest trigger bypasses the think cooldown", () => {
    const d = decideTickKind(input({ hasPending: true, hasTriggerPending: true, lastThinkTick: NOW - 1 * MIN }));
    expect(d.kind).toBe("think");
    expect(d.urgentBypass).toBe(false);
    expect(d.reason).toMatch(/trigger/);
  });

  it("urgency bypasses the cooldown but respects the 5-minute minimum spacing", () => {
    const urgent = input({ hasPending: true, pendingUrgency: 0.9 });
    expect(decideTickKind({ ...urgent, lastThinkTick: NOW - 2 * MIN }).kind).toBeNull();
    const d = decideTickKind({ ...urgent, lastThinkTick: NOW - 5 * MIN });
    expect(d.kind).toBe("think");
    expect(d.urgentBypass).toBe(true);
  });

  it("urgency without pending observations does not think", () => {
    expect(decideTickKind(input({ pendingUrgency: 0.9, lastThinkTick: NOW - 30 * MIN })).kind).toBeNull();
  });

  it("a deferred interrupt acts like an urgency bypass", () => {
    const d = decideTickKind(input({ hasPending: true, pendingInterrupt: true, lastThinkTick: NOW - 6 * MIN }));
    expect(d.kind).toBe("think");
    expect(d.urgentBypass).toBe(true);
    expect(d.reason).toMatch(/interrupt/);
  });

  it("thinks when idle for the time-awareness interval even without observations", () => {
    expect(decideTickKind(input({ lastThinkTick: NOW - 4 * HOUR })).kind).toBe("think");
  });

  it("thinks on initiative signals", () => {
    expect(decideTickKind(input({ initiativeTriggered: true })).kind).toBe("think");
  });
});
