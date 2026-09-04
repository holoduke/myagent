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

import { scoreUrgency, scoreObservations, scoreAndMaybeInterrupt, setUrgencyInterruptHandler, getPendingUrgency, clearPendingUrgency, compileKeywordPattern, isInterruptEligible } from "../backend/urgency.js";
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

  // ── Word boundaries (Unicode-aware) ──

  it("does not match '112' inside a phone number", () => {
    expect(scoreUrgency(makeObs({ text: "bel me op 0612345112 vanavond", isGroup: true }))).toBe(0);
  });

  it("still matches a standalone '112'", () => {
    expect(scoreUrgency(makeObs({ text: "ik heb 112 gebeld", isGroup: true }))).toBe(0.9);
  });

  it("does not match Dutch 'brand' in English 'brand new'", () => {
    expect(scoreUrgency(makeObs({ text: "got a brand new bike today", isGroup: true }))).toBe(0);
    expect(scoreUrgency(makeObs({ text: "brand-new laptop arrived", isGroup: true }))).toBe(0);
  });

  it("does not match 'ziek' inside 'muziek'", () => {
    expect(scoreUrgency(makeObs({ text: "wat een mooie muziek", isGroup: true }))).toBe(0);
  });

  it("matches 'ziek' as a whole word", () => {
    expect(scoreUrgency(makeObs({ text: "ik ben ziek vandaag", isGroup: true }))).toBe(0.3);
  });

  it("does not match 'sos' inside 'Sosa'", () => {
    expect(scoreUrgency(makeObs({ text: "Sosa scored again", isGroup: true }))).toBe(0);
  });

  it("matches keywords next to punctuation and accented letters", () => {
    expect(scoreUrgency(makeObs({ text: "Spoed! kom nu", isGroup: true }))).toBe(0.8);
    expect(scoreUrgency(makeObs({ text: "éspoed", isGroup: true }))).toBe(0);
  });
});

describe("compileKeywordPattern", () => {
  it("accepts any whitespace run inside multi-word keywords", () => {
    const re = compileKeywordPattern("zo snel mogelijk");
    expect(re.test("graag zo  snel\tmogelijk reageren")).toBe(true);
    expect(re.test("zosnelmogelijk")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(compileKeywordPattern("sos").test("SOS")).toBe(true);
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

  it("triggers interrupt handler for a trusted group message above threshold", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "emergency", isGroup: true, trustLevel: "trusted" }));
    expect(handler).toHaveBeenCalledWith(0.9);
  });

  it("triggers interrupt handler for a direct WhatsApp message from an unknown sender", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "emergency", isGroup: false, trustLevel: "untrusted" }));
    expect(handler).toHaveBeenCalledWith(0.9);
  });

  it("does not trigger handler below threshold", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "this is urgent", isGroup: true, trustLevel: "trusted" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("never interrupts for untrusted group content", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "EMERGENCY noodgeval", isGroup: true, trustLevel: "untrusted" }));
    expect(handler).not.toHaveBeenCalled();
    // The score still feeds the next scheduled tick
    expect(getPendingUrgency()).toBe(0.9);
  });

  it("never interrupts for RSS or email observations", () => {
    const handler = vi.fn();
    setUrgencyInterruptHandler(handler, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "emergency declared", source: "rss", isGroup: false, trustLevel: "untrusted" }));
    scoreAndMaybeInterrupt(makeObs({
      text: "emergency: action required",
      source: "gmail",
      isGroup: false,
      trustLevel: "untrusted",
      emailMeta: { from: "x@example.com", to: "me@example.com", subject: "hi", accountId: "a", accountEmail: "me@example.com", messageId: "m1" },
    }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("updates pending urgency", () => {
    setUrgencyInterruptHandler(() => {}, 0.8);
    scoreAndMaybeInterrupt(makeObs({ text: "urgent", isGroup: true }));
    expect(getPendingUrgency()).toBe(0.7);
  });
});

describe("isInterruptEligible", () => {
  it("is true for owner and trusted observations regardless of source", () => {
    expect(isInterruptEligible(makeObs({ source: "rss", trustLevel: "trusted" }))).toBe(true);
    expect(isInterruptEligible(makeObs({ source: "gmail", trustLevel: "owner" }))).toBe(true);
  });

  it("is true for direct messages on person-to-person channels", () => {
    expect(isInterruptEligible(makeObs({ isGroup: false, trustLevel: "untrusted" }))).toBe(true);
    expect(isInterruptEligible(makeObs({ source: "slack", isGroup: false, trustLevel: "untrusted" }))).toBe(true);
  });

  it("is false for untrusted groups, feeds and own messages", () => {
    expect(isInterruptEligible(makeObs({ isGroup: true, trustLevel: "untrusted" }))).toBe(false);
    expect(isInterruptEligible(makeObs({ source: "rss", isGroup: false, trustLevel: "untrusted" }))).toBe(false);
    expect(isInterruptEligible(makeObs({ isFromMe: true, trustLevel: "owner" }))).toBe(false);
  });
});
