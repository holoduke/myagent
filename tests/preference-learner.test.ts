import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  OWNER_NAME: "TestOwner",
}));

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((...args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { extractPreferenceSignals } from "../backend/preference-learner.js";
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

describe("extractPreferenceSignals", () => {
  it("returns empty for no owner messages", () => {
    const obs = [makeObs({ text: "Hello!", isFromMe: false })];
    const signals = extractPreferenceSignals(obs);
    expect(signals).toEqual([]);
  });

  it("detects short message preference", () => {
    const obs = Array.from({ length: 10 }, (_, i) =>
      makeObs({ text: `ok ${i}`, isFromMe: true, timestamp: Date.now() - i * 60000 })
    );
    const signals = extractPreferenceSignals(obs);
    const lengthSignal = signals.find(s => s.category === "message_length");
    expect(lengthSignal).toBeDefined();
    expect(lengthSignal!.value).toContain("short");
  });

  it("detects long message preference", () => {
    const longText = "A".repeat(250);
    const obs = Array.from({ length: 5 }, (_, i) =>
      makeObs({ text: longText, isFromMe: true, timestamp: Date.now() - i * 60000 })
    );
    const signals = extractPreferenceSignals(obs);
    const lengthSignal = signals.find(s => s.category === "message_length");
    expect(lengthSignal).toBeDefined();
    expect(lengthSignal!.value).toContain("longer");
  });

  it("detects active hours", () => {
    const hour14 = new Date();
    hour14.setHours(14, 0, 0, 0);
    const obs = Array.from({ length: 5 }, (_, i) =>
      makeObs({ text: `msg ${i}`, isFromMe: true, timestamp: hour14.getTime() + i * 1000 })
    );
    const signals = extractPreferenceSignals(obs);
    const hourSignal = signals.find(s => s.category === "active_hours");
    expect(hourSignal).toBeDefined();
    expect(hourSignal!.value).toContain("14:00");
  });

  it("detects quick reply engagement", () => {
    const now = Date.now();
    const obs = [
      makeObs({ text: "Hey can you help me?", isFromMe: false, sender: "Bob", timestamp: now - 30000, chatJid: "bob@s.whatsapp.net" }),
      makeObs({ text: "Sure!", isFromMe: true, timestamp: now, chatJid: "bob@s.whatsapp.net" }),
    ];
    const signals = extractPreferenceSignals(obs);
    const replySignal = signals.find(s => s.category === "topic_receptivity");
    expect(replySignal).toBeDefined();
    expect(replySignal!.value).toContain("quick reply");
  });

  it("detects Dutch language usage", () => {
    const obs = Array.from({ length: 10 }, (_, i) =>
      makeObs({ text: `hoi goed ${i} mooi fijn`, isFromMe: true, timestamp: Date.now() - i * 60000 })
    );
    const signals = extractPreferenceSignals(obs);
    const langSignal = signals.find(s => s.category === "language_pattern" && s.value.includes("Dutch"));
    expect(langSignal).toBeDefined();
  });

  it("detects emoji usage patterns", () => {
    const obs = Array.from({ length: 15 }, (_, i) =>
      makeObs({ text: `Nice! 😊👍 ${i}`, isFromMe: true, timestamp: Date.now() - i * 60000 })
    );
    const signals = extractPreferenceSignals(obs);
    const emojiSignal = signals.find(s => s.category === "language_pattern" && s.value.includes("emoji"));
    expect(emojiSignal).toBeDefined();
    expect(emojiSignal!.value).toContain("frequently");
  });

  it("detects rarely uses emojis", () => {
    const obs = Array.from({ length: 15 }, (_, i) =>
      makeObs({ text: `Plain text message ${i}`, isFromMe: true, timestamp: Date.now() - i * 60000 })
    );
    const signals = extractPreferenceSignals(obs);
    const emojiSignal = signals.find(s => s.category === "language_pattern" && s.value.includes("rarely"));
    expect(emojiSignal).toBeDefined();
  });
});
