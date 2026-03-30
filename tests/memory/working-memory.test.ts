import { describe, it, expect, vi } from "vitest";

vi.mock("../../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { info: () => {}, warn: () => {}, error: () => {} },
  ),
}));

vi.mock("../../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
}));

vi.mock("../../backend/utils/file-store.js", () => ({
  safeReadJSON: () => ({}),
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));

vi.mock("../../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC" }),
  getOwnerLocalTime: (_tz: string, now: Date) => ({
    hour: now.getUTCHours(),
    dayOfWeek: now.getUTCDay(),
  }),
  getOwnerLocalDate: (_tz: string, now: Date) => now.toISOString().slice(0, 10),
}));

vi.mock("../../backend/memory/activation.js", () => ({
  extractKeywordsFromText: (text: string) =>
    text.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3),
}));

import {
  updateWorkingMemory,
  cleanupWorkingMemory,
  updateConversationThreads,
  scanFollowUpsForResolution,
} from "../../backend/memory/working-memory.js";
import type { WorkingMemory, PendingFollowUp, ConversationThread } from "../../backend/memory/types.js";
import type { Observation } from "../../backend/observer.js";

function makeWM(overrides: Partial<WorkingMemory> = {}): WorkingMemory {
  return {
    currentContext: "",
    mood: "neutral",
    shortTermTracking: [],
    activatedNodeIds: [],
    lastUpdated: 0,
    activeGoals: [],
    pendingFollowUps: [],
    conversationThreads: [],
    temporal: {
      dayOfWeek: "Monday",
      timeOfDay: "morning",
      hour: 8,
      date: "2024-01-15",
      isWeekend: false,
      upcomingEvents: [],
    },
    ...overrides,
  };
}

function makeFollowUp(overrides: Partial<PendingFollowUp> = {}): PendingFollowUp {
  return {
    id: "fu_1",
    question: "Did you reply to the email?",
    context: "work email",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    timestamp: Date.now(),
    sender: "Someone",
    senderJid: "someone@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    text: "hello",
    source: "whatsapp",
    ...overrides,
  } as Observation;
}

// ── updateWorkingMemory ──

describe("updateWorkingMemory", () => {
  it("updates currentContext", () => {
    const wm = makeWM();
    const result = updateWorkingMemory(wm, { currentContext: "working on tests" });
    expect(result.currentContext).toBe("working on tests");
  });

  it("updates mood", () => {
    const wm = makeWM();
    const result = updateWorkingMemory(wm, { mood: "focused" });
    expect(result.mood).toBe("focused");
  });

  it("updates shortTermTracking", () => {
    const wm = makeWM();
    const items = ["item1", "item2"];
    const result = updateWorkingMemory(wm, { shortTermTracking: items });
    expect(result.shortTermTracking).toEqual(items);
  });

  it("sets lastUpdated to current time", () => {
    const wm = makeWM({ lastUpdated: 0 });
    const before = Date.now();
    const result = updateWorkingMemory(wm, { mood: "test" });
    expect(result.lastUpdated).toBeGreaterThanOrEqual(before);
  });

  it("does not change unspecified fields", () => {
    const wm = makeWM({ mood: "happy", currentContext: "coding" });
    const result = updateWorkingMemory(wm, { mood: "sad" });
    expect(result.mood).toBe("sad");
    expect(result.currentContext).toBe("coding"); // unchanged
  });

  it("updates activatedNodeIds", () => {
    const wm = makeWM();
    const result = updateWorkingMemory(wm, { activatedNodeIds: ["n1", "n2"] });
    expect(result.activatedNodeIds).toEqual(["n1", "n2"]);
  });
});

// ── cleanupWorkingMemory ──

describe("cleanupWorkingMemory", () => {
  it("trims shortTermTracking to max 25", () => {
    const items = Array.from({ length: 30 }, (_, i) => `item_${i}`);
    const wm = makeWM({ shortTermTracking: items });
    const result = cleanupWorkingMemory(wm);
    expect(wm.shortTermTracking).toHaveLength(25);
    expect(result.trackingTrimmed).toBe(5);
  });

  it("does not trim when under limit", () => {
    const wm = makeWM({ shortTermTracking: ["a", "b", "c"] });
    const result = cleanupWorkingMemory(wm);
    expect(wm.shortTermTracking).toHaveLength(3);
    expect(result.trackingTrimmed).toBe(0);
  });

  it("removes follow-ups older than 30 days without dueAt", () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const wm = makeWM({
      pendingFollowUps: [makeFollowUp({ createdAt: old })],
    });
    const result = cleanupWorkingMemory(wm);
    expect(wm.pendingFollowUps).toHaveLength(0);
    expect(result.followUpsPruned).toBe(1);
  });

  it("keeps fresh follow-ups", () => {
    const wm = makeWM({
      pendingFollowUps: [makeFollowUp({ createdAt: Date.now() })],
    });
    const result = cleanupWorkingMemory(wm);
    expect(wm.pendingFollowUps).toHaveLength(1);
    expect(result.followUpsPruned).toBe(0);
  });

  it("removes follow-ups past dueAt by > 7 days", () => {
    const pastDue = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const wm = makeWM({
      pendingFollowUps: [makeFollowUp({ dueAt: pastDue })],
    });
    cleanupWorkingMemory(wm);
    expect(wm.pendingFollowUps).toHaveLength(0);
  });

  it("keeps follow-ups within 7 days of dueAt", () => {
    const recentDue = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const wm = makeWM({
      pendingFollowUps: [makeFollowUp({ dueAt: recentDue })],
    });
    cleanupWorkingMemory(wm);
    expect(wm.pendingFollowUps).toHaveLength(1);
  });
});

// ── updateConversationThreads ──

describe("updateConversationThreads", () => {
  it("creates a new thread for a new sender", () => {
    const wm = makeWM();
    updateConversationThreads(wm, [makeObs({ sender: "Alice", senderJid: "alice@wa" })]);
    expect(wm.conversationThreads).toHaveLength(1);
    expect(wm.conversationThreads[0].participants).toContain("Alice");
  });

  it("updates existing thread", () => {
    const now = Date.now();
    const thread: ConversationThread = {
      id: "dm:bob@wa",
      participants: ["Bob"],
      topic: "old topic",
      lastMessageAt: now - 1000,
      messageCount: 5,
      status: "active",
    };
    const wm = makeWM({ conversationThreads: [thread] });

    updateConversationThreads(wm, [
      makeObs({ sender: "Bob", senderJid: "bob@wa", chatJid: "bob@wa", timestamp: now }),
    ]);

    expect(wm.conversationThreads).toHaveLength(1);
    expect(wm.conversationThreads[0].messageCount).toBe(6);
    expect(wm.conversationThreads[0].lastMessageAt).toBe(now);
  });

  it("adds new participants to existing thread", () => {
    const thread: ConversationThread = {
      id: "dm:bob@wa",
      participants: ["Bob"],
      topic: "test",
      lastMessageAt: Date.now(),
      messageCount: 1,
      status: "active",
    };
    const wm = makeWM({ conversationThreads: [thread] });

    updateConversationThreads(wm, [
      makeObs({ sender: "Charlie", senderJid: "charlie@wa", chatJid: "bob@wa" }),
    ]);

    expect(wm.conversationThreads[0].participants).toContain("Bob");
    expect(wm.conversationThreads[0].participants).toContain("Charlie");
  });

  it("marks threads as stale after 48h", () => {
    const staleTime = Date.now() - 49 * 60 * 60 * 1000;
    const thread: ConversationThread = {
      id: "dm:old@wa",
      participants: ["Old"],
      topic: "old chat",
      lastMessageAt: staleTime,
      messageCount: 3,
      status: "active",
    };
    const wm = makeWM({ conversationThreads: [thread] });

    updateConversationThreads(wm, []); // Trigger lifecycle check

    expect(wm.conversationThreads[0].status).toBe("stale");
  });

  it("marks stale threads as closed after 7 days", () => {
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const thread: ConversationThread = {
      id: "dm:veryold@wa",
      participants: ["VeryOld"],
      topic: "ancient chat",
      lastMessageAt: oldTime,
      messageCount: 1,
      status: "stale",
    };
    const wm = makeWM({ conversationThreads: [thread] });

    updateConversationThreads(wm, []);

    expect(wm.conversationThreads[0].status).toBe("closed");
  });

  it("removes closed threads older than 14 days", () => {
    const ancientTime = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const thread: ConversationThread = {
      id: "dm:ancient@wa",
      participants: ["Ancient"],
      topic: "dead chat",
      lastMessageAt: ancientTime,
      messageCount: 1,
      status: "closed",
    };
    const wm = makeWM({ conversationThreads: [thread] });

    updateConversationThreads(wm, []);

    expect(wm.conversationThreads).toHaveLength(0);
  });

  it("caps at 20 threads", () => {
    const threads: ConversationThread[] = Array.from({ length: 25 }, (_, i) => ({
      id: `dm:user${i}@wa`,
      participants: [`User${i}`],
      topic: `chat ${i}`,
      lastMessageAt: Date.now() - i * 1000,
      messageCount: 1,
      status: "active" as const,
    }));
    const wm = makeWM({ conversationThreads: threads });

    updateConversationThreads(wm, []);

    expect(wm.conversationThreads.length).toBeLessThanOrEqual(20);
  });
});

// ── scanFollowUpsForResolution ──

describe("scanFollowUpsForResolution", () => {
  it("marks follow-up as resolved when outgoing message matches keywords", () => {
    const wm = makeWM({
      pendingFollowUps: [
        makeFollowUp({
          question: "Did you reply about the project deadline?",
          context: "project planning",
          targetPerson: "Alice",
        }),
      ],
    });

    const result = scanFollowUpsForResolution(wm, [
      makeObs({
        isFromMe: true,
        text: "Hey Alice, about the project deadline, here is my reply",
        chatName: "Alice",
      }),
    ]);

    expect(result).toBe(1);
    expect(wm.pendingFollowUps[0].potentiallyResolved).toBe(true);
  });

  it("does not mark follow-up for incoming messages", () => {
    const wm = makeWM({
      pendingFollowUps: [
        makeFollowUp({ question: "project update?" }),
      ],
    });

    scanFollowUpsForResolution(wm, [
      makeObs({ isFromMe: false, text: "project update coming soon" }),
    ]);

    expect(wm.pendingFollowUps[0].potentiallyResolved).toBeUndefined();
  });

  it("returns 0 when no follow-ups exist", () => {
    const wm = makeWM();
    const result = scanFollowUpsForResolution(wm, [makeObs({ isFromMe: true })]);
    expect(result).toBe(0);
  });

  it("skips already-resolved follow-ups", () => {
    const wm = makeWM({
      pendingFollowUps: [
        makeFollowUp({
          question: "project deadline",
          potentiallyResolved: true,
        }),
      ],
    });

    const result = scanFollowUpsForResolution(wm, [
      makeObs({ isFromMe: true, text: "project deadline confirmed" }),
    ]);

    expect(result).toBe(0);
  });
});
