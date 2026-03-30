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

import { extractKeywordsFromText, extractKeywords, calculateContextBudget } from "../backend/memory/activation.js";
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

// ── extractKeywordsFromText ──

describe("extractKeywordsFromText", () => {
  it("extracts words with 3+ characters", () => {
    const result = extractKeywordsFromText("I am OK but the cat is big");
    // "ok" and "am" are stop words; "cat" and "big" are 3 chars each
    expect(result).toContain("cat");
    expect(result).toContain("big");
    expect(result).not.toContain("am");
    expect(result).not.toContain("ok");
  });

  it("removes stop words (English)", () => {
    const result = extractKeywordsFromText("the quick brown fox jumps");
    expect(result).not.toContain("the");
    expect(result).toContain("quick");
    expect(result).toContain("brown");
    expect(result).toContain("fox");
    expect(result).toContain("jumps");
  });

  it("removes stop words (Dutch)", () => {
    const result = extractKeywordsFromText("het grote huis van mijn vader");
    expect(result).not.toContain("het");
    expect(result).not.toContain("van");
    expect(result).toContain("grote");
    expect(result).toContain("huis");
    expect(result).toContain("vader");
  });

  it("handles Unicode characters", () => {
    const result = extractKeywordsFromText("café résumé naïve");
    expect(result).toContain("café");
    expect(result).toContain("résumé");
    expect(result).toContain("naïve");
  });

  it("deduplicates keywords", () => {
    const result = extractKeywordsFromText("cat cat cat dog dog");
    expect(result.filter(w => w === "cat").length).toBe(1);
    expect(result.filter(w => w === "dog").length).toBe(1);
  });

  it("lowercases all keywords", () => {
    const result = extractKeywordsFromText("Meeting TOMORROW Presentation");
    result.forEach(w => expect(w).toBe(w.toLowerCase()));
  });

  it("strips punctuation but keeps hyphens and apostrophes", () => {
    const result = extractKeywordsFromText("well-known it's really good!");
    expect(result).toContain("well-known");
    expect(result).toContain("it's");
  });

  it("returns empty array for all stop words", () => {
    const result = extractKeywordsFromText("I am the one who is");
    expect(result).toEqual([]);
  });
});

// ── extractKeywords ──

describe("extractKeywords", () => {
  it("extracts keywords from observation text", () => {
    const obs = [makeObs({ text: "The weather forecast says rain tomorrow" })];
    const result = extractKeywords(obs);
    expect(result).toContain("weather");
    expect(result).toContain("forecast");
    expect(result).toContain("rain");
  });

  it("weights sender names higher (3x)", () => {
    const obs = [
      makeObs({ text: "meeting tomorrow", sender: "Christina" }),
    ];
    const result = extractKeywords(obs);
    // "christina" should rank higher than "meeting" with only 1 occurrence
    const christinaIdx = result.indexOf("christina");
    const meetingIdx = result.indexOf("meeting");
    expect(christinaIdx).toBeLessThan(meetingIdx);
  });

  it("weights group names (2x)", () => {
    const obs = [
      makeObs({ text: "planning session", groupName: "Project Alpha", isGroup: true }),
    ];
    const result = extractKeywords(obs);
    expect(result).toContain("project alpha");
  });

  it("sorts by frequency descending", () => {
    const obs = [
      makeObs({ text: "deployment deployment deployment server server logs" }),
    ];
    const result = extractKeywords(obs);
    expect(result.indexOf("deployment")).toBeLessThan(result.indexOf("logs"));
  });

  it("limits to top 30 terms", () => {
    // Generate a text with many unique long words
    const words = Array.from({ length: 50 }, (_, i) => `keyword${String(i).padStart(3, "0")}`);
    const obs = [makeObs({ text: words.join(" ") })];
    const result = extractKeywords(obs);
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it("handles empty observations", () => {
    expect(extractKeywords([])).toEqual([]);
  });
});

// ── calculateContextBudget ──

describe("calculateContextBudget", () => {
  it("returns base budget with no signals or urgency", () => {
    expect(calculateContextBudget(20, 0, 0)).toBe(20);
  });

  it("adds 5 per signal", () => {
    expect(calculateContextBudget(20, 1, 0)).toBe(25);
    expect(calculateContextBudget(20, 2, 0)).toBe(30);
  });

  it("caps signal bonus at 15", () => {
    // 4 signals * 5 = 20, but max bonus is 15
    expect(calculateContextBudget(20, 4, 0)).toBe(35);
    expect(calculateContextBudget(20, 10, 0)).toBe(35);
  });

  it("adds 10 for high urgency (>0.6)", () => {
    expect(calculateContextBudget(20, 0, 0.7)).toBe(30);
    expect(calculateContextBudget(20, 0, 0.9)).toBe(30);
  });

  it("does not add urgency bonus at or below threshold", () => {
    expect(calculateContextBudget(20, 0, 0.6)).toBe(20);
    expect(calculateContextBudget(20, 0, 0.3)).toBe(20);
  });

  it("caps total at 50", () => {
    // 40 base + 15 signal + 10 urgency = 65, capped at 50
    expect(calculateContextBudget(40, 5, 0.9)).toBe(50);
  });

  it("works with 0 base budget", () => {
    expect(calculateContextBudget(0, 0, 0)).toBe(0);
    expect(calculateContextBudget(0, 3, 0.8)).toBe(25); // 0 + 15 + 10
  });
});
