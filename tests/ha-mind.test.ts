import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC", characterType: "default", models: {} }),
  getCharacterPreset: () => ({ traits: "- Sharp, warm to {owner}", voice: "" }),
  getOwnerLocalTime: (_tz: string, now: Date = new Date()) => ({ hour: now.getUTCHours(), dayOfWeek: now.getUTCDay() }),
  getOwnerLocalDate: (_tz: string, now: Date = new Date()) => now.toISOString().slice(0, 10),
}));
vi.mock("../backend/memory/working-memory.js", () => ({
  loadWorkingMemory: () => ({
    currentContext: "Gillis werkt aan de Home Assistant koppeling",
    mood: "curious",
    shortTermTracking: ["Thea's verjaardag vandaag"],
    pendingFollowUps: [{ id: "f1", question: "Heeft Rob al gereageerd op de offerte?", targetPerson: "Rob", context: "", createdAt: 1 }],
    activeGoals: [{ nodeId: "g1", title: "Football Mania release", priority: 1, progress: 0.6, deadlineStatus: "on_track" }],
    conversationThreads: [{ id: "t1", participants: ["Ilse"], topic: "weekendplannen", lastMessageAt: 1, messageCount: 3, status: "active" }],
    activatedNodeIds: [], lastUpdated: 0, temporal: {},
  }),
}));
vi.mock("../backend/consciousness.js", () => ({
  getConsciousnessSummary: () => "ik merk dat Gillis vandaag veel aan het bouwen is.",
}));
vi.mock("../backend/observer.js", () => ({
  getObservationsSince: () => [
    { timestamp: Date.parse("2026-09-04T08:10:00Z"), sender: "Ilse", senderJid: "x", isGroup: false, isFromMe: false, text: "Kom je vanavond op tijd thuis?", source: "whatsapp" },
    { timestamp: Date.parse("2026-09-04T09:00:00Z"), sender: "Home Assistant", senderJid: "ha:digest", isGroup: false, isFromMe: false, text: "[HOME DIGEST 09:00, 1 events]\n- x", source: "homeassistant" },
    { timestamp: Date.parse("2026-09-04T10:00:00Z"), sender: "Gillis", senderJid: "me", isGroup: true, groupName: "Koreman en Co", isFromMe: true, text: "Gefeliciteerd Thea!", source: "whatsapp" },
  ],
}));
vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({ lastBrainMessage: { at: Date.parse("2026-09-04T11:00:00Z"), targetJid: "me", snippet: "je hebt om 14:00 die call", status: "sent", verified: true } }),
  FileStore: class { load() { return null; } save() {} exists() { return false; } },
  ensureDir: () => {}, atomicWriteFile: () => {}, atomicWriteJSON: () => {},
}));

import { gatherMindContext, buildMindPrompt, buildMindTemplate, composeMindBriefing } from "../backend/ha-mind.js";

const NOW = new Date("2026-09-04T12:30:00Z");

describe("gatherMindContext", () => {
  it("collects working memory, notes, today's observations and the last sent message", () => {
    const ctx = gatherMindContext(NOW, "Gillis");
    expect(ctx.hour).toBe(12);
    expect(ctx.currentContext).toContain("Home Assistant");
    expect(ctx.followUps[0]).toBe("Heeft Rob al gereageerd op de offerte? (Rob)");
    expect(ctx.goals[0]).toBe("Football Mania release (60%)");
    expect(ctx.threads[0]).toBe("Ilse: weekendplannen");
    expect(ctx.consciousness).toContain("bouwen");
    // the HOME DIGEST line is filtered out, the two real messages remain
    expect(ctx.observationCount).toBe(2);
    expect(ctx.observations[0]).toContain("Ilse: Kom je vanavond");
    expect(ctx.observations[1]).toContain("Gillis in Koreman en Co: Gefeliciteerd");
    expect(ctx.lastMessage).toContain("die call");
  });
});

describe("prompt and template", () => {
  it("prompt carries the persona, the rules and the data", () => {
    const prompt = buildMindPrompt(gatherMindContext(NOW, "Gillis"), "Gillis");
    expect(prompt).toContain("Goedemiddag Gillis.");
    expect(prompt).toContain("warm to Gillis");
    expect(prompt).toContain("Niet het weer");
    expect(prompt).toContain("Heeft Rob al gereageerd");
    expect(prompt).toContain("Kom je vanavond");
  });

  it("template is honest and short", () => {
    const text = buildMindTemplate(gatherMindContext(NOW, "Gillis"), "Gillis");
    expect(text).toBe("Goedemiddag Gillis. Vandaag heb ik 2 berichten voorbij zien komen. Waar ik mee bezig ben: Gillis werkt aan de Home Assistant koppeling. Wat nog open staat: Heeft Rob al gereageerd op de offerte? (Rob).");
  });
});

describe("composeMindBriefing", () => {
  it("uses the model when it answers and falls back to the template otherwise", async () => {
    const good = await composeMindBriefing({ now: NOW, ownerName: "Gillis", llm: { run: async () => "Goedemiddag Gillis. Ilse vroeg of je op tijd thuis bent, en ik wacht nog op Rob." } });
    expect(good.usedLLM).toBe(true);
    expect(good.text).toContain("Ilse");
    expect(good.observationCount).toBe(2);

    const bad = await composeMindBriefing({ now: NOW, ownerName: "Gillis", llm: { run: async () => null } });
    expect(bad.usedLLM).toBe(false);
    expect(bad.text.startsWith("Goedemiddag Gillis. Vandaag heb ik 2 berichten")).toBe(true);

    const thrown = await composeMindBriefing({ now: NOW, ownerName: "Gillis", llm: { run: async () => { throw new Error("boom"); } } });
    expect(thrown.usedLLM).toBe(false);
  });

  it("rejects overly long model output", async () => {
    const r = await composeMindBriefing({ now: NOW, ownerName: "Gillis", llm: { run: async () => "x".repeat(800) } });
    expect(r.usedLLM).toBe(false);
  });
});
