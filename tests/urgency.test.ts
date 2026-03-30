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

import { scoreUrgency, scoreObservations, scoreAndMaybeInterrupt, setUrgencyInterruptHandler, getPendingUrgency, clearPendingUrgency } from "../backend/urgency.js";
import type { Observation } from "../backend/observer.js";

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    text: "",
    sender: "Alice",
    senderJid: "alice@s.whatsapp.net",
    chatJid: "alice@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    groupName: undefined,
    timestamp: Date.now(),
    urgency: 0,
    ...overrides,
  } as Observation;
}

// ── scoreUrgency ──

describe("scoreUrgency", () => {
  it("returns 0 for own messages", () => {
    expect(scoreUrgency(makeObs({ text: "EMERGENCY!!!", isFromMe: true }))).toBe(0);
  });

  it("gives DM base score of 0.3 for non-group messages", () => {
    const score = scoreUrgency(makeObs({ text: "hello there friend" }));
    expect(score).toBeCloseTo(0.3, 1);
  });

  it("gives 0 for a group message with no keywords", () => {
    expect(scoreUrgency(makeObs({ text: "hello", isGroup: true }))).toBe(0);
  });

  // ── English keywords ──

  it("scores 'emergency' at 0.9", () => {
    const score = scoreUrgency(makeObs({ text: "This is an emergency!", isGroup: true }));
    expect(score).toBe(0.9);
  });

  it("scores 'urgent' at 0.7", () => {
    const score = scoreUrgency(makeObs({ text: "this is urgent", isGroup: true }));
    expect(score).toBe(0.7);
  });

  it("scores 'help' at 0.4", () => {
    const score = scoreUrgency(makeObs({ text: "I need help", isGroup: true }));
    expect(score).toBe(0.4);
  });

  it("scores 'sos' at 0.9", () => {
    expect(scoreUrgency(makeObs({ text: "SOS SOS", isGroup: true }))).toBe(0.9);
  });

  // ── Dutch keywords ──

  it("scores Dutch 'noodgeval' at 0.9", () => {
    expect(scoreUrgency(makeObs({ text: "Dit is een noodgeval", isGroup: true }))).toBe(0.9);
  });

  it("scores Dutch 'dringend' at 0.7", () => {
    expect(scoreUrgency(makeObs({ text: "dringend nodig", isGroup: true }))).toBe(0.7);
  });

  it("scores Dutch 'brand' (fire) at 0.9", () => {
    expect(scoreUrgency(makeObs({ text: "er is brand!", isGroup: true }))).toBe(0.9);
  });

  it("scores Dutch 'gestolen' (stolen) at 0.7", () => {
    expect(scoreUrgency(makeObs({ text: "mijn fiets is gestolen", isGroup: true }))).toBe(0.7);
  });

  // ── DM + keyword interaction ──

  it("keyword overrides DM base when keyword is higher", () => {
    // DM base is 0.3, but "urgent" is 0.7 — keyword should win
    const score = scoreUrgency(makeObs({ text: "this is urgent" }));
    expect(score).toBe(0.7);
  });

  it("DM base applies when keyword is lower", () => {
    // DM base is 0.3, "soon" is 0.2 — DM base wins
    const score = scoreUrgency(makeObs({ text: "see you soon" }));
    expect(score).toBeCloseTo(0.3, 1);
  });

  // ── Owner mention in group ──

  it("boosts to 0.5 when owner name is mentioned in group", () => {
    const score = scoreUrgency(makeObs({ text: "Hey testowner, are you there?", isGroup: true }));
    expect(score).toBe(0.5);
  });

  it("does not boost owner mention in DM", () => {
    const score = scoreUrgency(makeObs({ text: "Hey testowner" }));
    // DM base is 0.3, owner mention only applies in group
    expect(score).toBeCloseTo(0.3, 1);
  });

  // ── ALL CAPS detection ──

  it("boosts ALL CAPS messages to at least 0.5", () => {
    const score = scoreUrgency(makeObs({ text: "WHERE ARE YOU RIGHT NOW PLEASE", isGroup: true }));
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it("does not trigger ALL CAPS for short messages", () => {
    const score = scoreUrgency(makeObs({ text: "OK FINE", isGroup: true }));
    // Only 7 chars, below 10 char minimum
    expect(score).toBe(0);
  });

  // ── Punctuation density ──

  it("boosts high punctuation density to at least 0.4", () => {
    const score = scoreUrgency(makeObs({ text: "what is going on??? are you ok?!", isGroup: true }));
    expect(score).toBeGreaterThanOrEqual(0.4);
  });

  it("does not boost low punctuation", () => {
    const score = scoreUrgency(makeObs({ text: "sounds good!", isGroup: true }));
    expect(score).toBe(0); // only 1 exclamation mark
  });

  // ── Time decay ──

  it("does not decay messages younger than 5 minutes", () => {
    const obs = makeObs({ text: "emergency", isGroup: true, timestamp: Date.now() - 2 * 60 * 1000 });
    expect(scoreUrgency(obs)).toBe(0.9);
  });

  it("decays messages older than 5 minutes", () => {
    // 1 hour old → half-life decay
    const obs = makeObs({ text: "emergency", isGroup: true, timestamp: Date.now() - 60 * 60 * 1000 });
    const score = scoreUrgency(obs);
    expect(score).toBeCloseTo(0.45, 1); // 0.9 * 0.5 = 0.45
  });

  it("heavily decays very old messages", () => {
    // 3 hours old → 0.9 * 0.5^3 = 0.1125
    const obs = makeObs({ text: "emergency", isGroup: true, timestamp: Date.now() - 3 * 60 * 60 * 1000 });
    const score = scoreUrgency(obs);
    expect(score).toBeLessThan(0.15);
  });

  it("caps score at 1.0", () => {
    // Even with multiple boosters, should not exceed 1.0
    const score = scoreUrgency(makeObs({ text: "EMERGENCY EMERGENCY!!!", isGroup: true }));
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ── scoreObservations ──

describe("scoreObservations", () => {
  beforeEach(() => {
    clearPendingUrgency();
  });

  it("sets urgency on each observation", () => {
    const obs = [
      makeObs({ text: "emergency", isGroup: true }),
      makeObs({ text: "hello", isGroup: true }),
    ];
    scoreObservations(obs);
    expect(obs[0].urgency).toBe(0.9);
    expect(obs[1].urgency).toBe(0);
  });

  it("updates pending urgency to max", () => {
    const obs = [
      makeObs({ text: "hello", isGroup: true }),
      makeObs({ text: "urgent please", isGroup: true }),
    ];
    scoreObservations(obs);
    expect(getPendingUrgency()).toBe(0.7);
  });

  it("replaces (not accumulates) pending urgency", () => {
    scoreObservations([makeObs({ text: "emergency", isGroup: true })]);
    expect(getPendingUrgency()).toBe(0.9);
    // Second call with lower urgency should replace
    scoreObservations([makeObs({ text: "hello", isGroup: true })]);
    expect(getPendingUrgency()).toBe(0);
  });
});

// ── scoreAndMaybeInterrupt ──

describe("scoreAndMaybeInterrupt", () => {
  beforeEach(() => {
    clearPendingUrgency();
  });

  it("triggers interrupt handler when urgency exceeds threshold", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "emergency", isGroup: true }));
    expect(handler).toHaveBeenCalledWith(0.9);
  });

  it("does not trigger handler below threshold", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "this is urgent", isGroup: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("updates pending urgency", () => {
    setUrgencyInterruptHandler(() => {}, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "urgent", isGroup: true }));
    expect(getPendingUrgency()).toBe(0.7);
  });
});
