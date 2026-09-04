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
vi.mock("../backend/memory/graph.js", () => ({
  MemoryGraph: class {
    load() {}
    allNodes() {
      const now = Date.now();
      return [
        { id: "p1", type: "person", content: "Ilse — partner van Gillis, houdt van wandelen", tags: [], strength: 0.9, pinned: true, createdAt: 1, lastAccessedAt: now, accessCount: 5 },
        { id: "e1", type: "event", content: "Lucas heeft zaterdag een wedstrijd", tags: [], strength: 0.6, pinned: false, importance: 0.7, createdAt: 1, lastAccessedAt: now - 3_600_000, accessCount: 2 },
        { id: "m1", type: "meta", content: "tick stats", tags: [], strength: 0.9, pinned: false, createdAt: 1, lastAccessedAt: now, accessCount: 1 },
        { id: "w1", type: "fact", content: "weak old fact", tags: [], strength: 0.1, pinned: false, createdAt: 1, lastAccessedAt: 1, accessCount: 1 },
      ];
    }
  },
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
const history = vi.hoisted(() => ({ entries: [] as Array<{ at: number; text: string }> }));
vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({ lastBrainMessage: { at: Date.parse("2026-09-04T11:00:00Z"), targetJid: "me", snippet: "je hebt om 14:00 die call", status: "sent", verified: true } }),
  FileStore: class { load() { return history; } save(v: { entries: Array<{ at: number; text: string }> }) { history.entries = v.entries; } exists() { return false; } },
  ensureDir: () => {}, atomicWriteFile: () => {}, atomicWriteJSON: () => {},
}));

import { gatherMindContext, buildMindPrompt, buildMindTemplate, composeMindBriefing, selectMemories, seededRandom, MIND_ANGLES, loadMindHistory } from "../backend/ha-mind.js";
import { beforeEach } from "vitest";

beforeEach(() => { history.entries = []; });

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
    // long-term memory: pinned first, meta and weak nodes excluded
    expect(ctx.memories[0]).toBe("[person, vast] Ilse — partner van Gillis, houdt van wandelen");
    expect(ctx.memories).toHaveLength(2);
  });
});

describe("selectMemories", () => {
  it("keeps pinned nodes, draws the rest from the top pool, and varies per seed", () => {
    const now = Date.now();
    const nodes = Array.from({ length: 120 }, (_, i) => ({
      id: `n${i}`, type: "fact" as const, content: `feit ${i}`, tags: [], strength: 0.5, pinned: i === 119, importance: i / 200,
      createdAt: 1, lastAccessedAt: now - i * 3_600_000, accessCount: 1,
    }));
    const a = selectMemories(nodes, now, 6, seededRandom(1));
    const b = selectMemories(nodes, now, 6, seededRandom(2));
    expect(a).toHaveLength(6);
    expect(a[0]).toBe("[fact, vast] feit 119");
    expect(b[0]).toBe("[fact, vast] feit 119");
    expect(a.join("|")).not.toBe(b.join("|"));
  });

  it("rotates the angle with the seed and includes previous briefings", () => {
    const c1 = gatherMindContext(NOW, "Gillis", undefined, 1);
    const c2 = gatherMindContext(NOW, "Gillis", undefined, 2);
    expect(MIND_ANGLES).toContain(c1.angle);
    expect(new Set(Array.from({ length: 20 }, (_, i) => gatherMindContext(NOW, "Gillis", undefined, i).angle)).size).toBeGreaterThan(2);
    expect(c1.previous).toEqual([]);
    history.entries = [{ at: 1, text: "Goedemiddag Gillis. De garage loste zichzelf op." }];
    expect(gatherMindContext(NOW, "Gillis", undefined, 3).previous).toEqual(["Goedemiddag Gillis. De garage loste zichzelf op."]);
    expect(buildMindPrompt(gatherMindContext(NOW, "Gillis", undefined, 3), "Gillis")).toContain("EERDER GEZEGD");
    void c2;
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
    expect(prompt).toContain("langetermijngeheugen");
    expect(prompt).toContain("Ilse — partner");
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
    expect(loadMindHistory().map(e => e.text)).toEqual([good.text]);

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
