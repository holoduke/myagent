import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { rmSync, readFileSync, existsSync, writeFileSync, utimesSync, appendFileSync } from "fs";
import { join } from "path";

const { brainDir } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  return { brainDir: mkdtempSync(join(tmpdir(), "observer-")) };
});

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: brainDir,
  OWNER_PHONE: "31600000000",
  OWNER_NAME: "TestOwner",
}));

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ enabled: true, ownerTimezone: "Europe/Amsterdam", urgencyInterruptThreshold: 0.8 }),
  getOwnerLocalDate: () => "2026-09-05",
}));

const evaluator = vi.hoisted(() => ({
  evaluateMessage: vi.fn(async () => ({
    intent: { intent: "question", confidence: 0.7, method: "heuristic", reason: "test" },
    regexSignals: [],
    detectedEvents: [],
    detectedRequests: [],
    llmSignals: [{ category: "request", snippet: "x", pattern: "unified-evaluator" }],
    reply: null,
    replyDirectiveId: null,
    usedLLM: true,
  })),
}));
vi.mock("../backend/message-evaluator.js", () => evaluator);

const replyAgent = vi.hoisted(() => ({ dispatchReply: vi.fn(async () => {}) }));
vi.mock("../backend/reply-agent.js", () => replyAgent);

const handlers = vi.hoisted(() => ({ runMessageHandlers: vi.fn(async () => {}) }));
vi.mock("../backend/message-handlers.js", () => handlers);

const tracker = vi.hoisted(() => ({ processObservation: vi.fn() }));
vi.mock("../backend/actionable-tracker.js", () => tracker);

vi.mock("../backend/frequency-tracker.js", () => ({ updateFrequency: vi.fn() }));
vi.mock("../backend/commitments.js", () => ({ extractAndClassifyCommitments: () => [] }));

import {
  recordObservation,
  getObservationKey,
  getObservationsSince,
  getObservationCountSince,
  pruneObservations,
} from "../backend/observer.js";
import type { Observation } from "../backend/observer.js";

const OBS_FILE = join(brainDir, "observations.jsonl");
const ENRICH_FILE = join(brainDir, "observation-enrichment.jsonl");
const DEDUP_FILE = join(brainDir, "observer-dedup.json");
const LOCK_FILE = join(brainDir, "observations.prune.lock");

let seq = 0;
function makeObs(overrides: Partial<Observation> = {}): Observation {
  seq++;
  return {
    timestamp: Date.now(),
    sender: "Alice",
    senderJid: "alice@s.whatsapp.net",
    chatJid: "alice@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    text: `message number ${seq}`,
    source: "whatsapp",
    ...overrides,
  };
}

function readLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
}

const flush = () => new Promise(resolve => setTimeout(resolve, 5));

beforeEach(() => {
  for (const f of [OBS_FILE, ENRICH_FILE, LOCK_FILE]) rmSync(f, { force: true });
  evaluator.evaluateMessage.mockClear();
  tracker.processObservation.mockClear();
});

afterAll(() => {
  rmSync(brainDir, { recursive: true, force: true });
});

describe("recordObservation", () => {
  it("persists the line with trust level and urgency already scored", () => {
    recordObservation(makeObs({ text: "dit is een noodgeval, help!" }));
    const [line] = readLines(OBS_FILE);
    expect(line.urgency).toBe(0.9);
    expect(line.trustLevel).toBe("untrusted");
  });

  it("dedups WhatsApp messages by message id instead of timestamp", () => {
    const first = makeObs({ messageId: "ABC", text: "hoi" });
    recordObservation(first);
    recordObservation({ ...first, timestamp: first.timestamp + 5000, text: "hoi (edited)" });
    expect(readLines(OBS_FILE)).toHaveLength(1);
    expect(getObservationKey(first)).toBe("wa:alice@s.whatsapp.net:ABC");
  });

  it("falls back to sender+timestamp+text without a message id", () => {
    const obs = makeObs({ text: "zonder id" });
    expect(getObservationKey(obs)).toBe(`whatsapp:alice@s.whatsapp.net:${obs.timestamp}:zonder id`);
  });

  it("flushes the dedup set to disk at least every 20 inserts", () => {
    // The insert counter is module-global, so any window of 20 inserts must
    // contain a flush — and that flush includes keys from the window.
    const batch = (tag: string) => {
      rmSync(DEDUP_FILE, { force: true });
      for (let i = 0; i < 20; i++) recordObservation(makeObs({ messageId: `${tag}-${i}` }));
      expect(existsSync(DEDUP_FILE)).toBe(true);
      const saved = JSON.parse(readFileSync(DEDUP_FILE, "utf-8")) as string[];
      expect(saved.some(k => k.includes(`:${tag}-`))).toBe(true);
    };
    batch("flushA");
    batch("flushB");
  });

  it("appends an enrichment record keyed by the observation key when evaluation finishes", async () => {
    const obs = makeObs({ messageId: "ENR1", text: "kun je iets voor me doen?" });
    recordObservation(obs);
    await flush();
    const records = readLines(ENRICH_FILE);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      key: "wa:alice@s.whatsapp.net:ENR1",
      ts: obs.timestamp,
      intent: "question",
      signals: 1,
      usedLLM: true,
      reply: false,
    });
    expect(tracker.processObservation).toHaveBeenCalledTimes(1);
  });

  it("does not evaluate own messages or Home Assistant digests", async () => {
    recordObservation(makeObs({ isFromMe: true, messageId: "ME1" }));
    recordObservation(makeObs({ source: "homeassistant", senderJid: "ha", text: "digest" }));
    await flush();
    expect(evaluator.evaluateMessage).not.toHaveBeenCalled();
    expect(handlers.runMessageHandlers).toHaveBeenCalled();
  });
});

describe("getObservationsSince (tail reader)", () => {
  it("does not stop on a single older line interleaved in a newer chunk", () => {
    const now = Date.now();
    const lines: string[] = [];
    const total = 4000; // > 256 KB so multiple tail chunks are read
    for (let i = 0; i < total; i++) {
      const ts = i === total - 10 ? now - 10 * 3_600_000 : now - 3_600_000 + i;
      lines.push(JSON.stringify(makeObs({ timestamp: ts, text: `padding ${"x".repeat(150)} ${i}` })));
    }
    writeFileSync(OBS_FILE, lines.join("\n") + "\n");

    const since = now - 2 * 3_600_000;
    expect(getObservationsSince(since)).toHaveLength(total - 1);
    expect(getObservationCountSince(since)).toBe(total - 1);
  });

  it("stops once an entire chunk is older than since", () => {
    const now = Date.now();
    const old = Array.from({ length: 3000 }, (_, i) => JSON.stringify(makeObs({ timestamp: now - 20 * 3_600_000 + i, text: "o".repeat(150) })));
    const fresh = Array.from({ length: 50 }, (_, i) => JSON.stringify(makeObs({ timestamp: now - 60_000 + i, text: "n".repeat(150) })));
    writeFileSync(OBS_FILE, [...old, ...fresh].join("\n") + "\n");
    expect(getObservationsSince(now - 3_600_000)).toHaveLength(50);
  });
});

describe("pruneObservations", () => {
  it("removes old lines and keeps recent ones", () => {
    const now = Date.now();
    writeFileSync(OBS_FILE, [
      JSON.stringify(makeObs({ timestamp: now - 10 * 86400000 })),
      JSON.stringify(makeObs({ timestamp: now - 60_000 })),
    ].join("\n") + "\n");
    writeFileSync(ENRICH_FILE, [
      JSON.stringify({ t: now, key: "a", ts: now - 10 * 86400000 }),
      JSON.stringify({ t: now, key: "b", ts: now - 60_000 }),
    ].join("\n") + "\n");
    expect(pruneObservations(7)).toBe(true);
    expect(readLines(OBS_FILE)).toHaveLength(1);
    expect(readLines(ENRICH_FILE)).toHaveLength(1);
    expect(existsSync(LOCK_FILE)).toBe(false);
  });

  it("skips when another instance holds a fresh lock", () => {
    writeFileSync(OBS_FILE, JSON.stringify(makeObs({ timestamp: Date.now() - 10 * 86400000 })) + "\n");
    writeFileSync(LOCK_FILE, "other-instance");
    expect(pruneObservations(7)).toBe(false);
    expect(readLines(OBS_FILE)).toHaveLength(1);
    expect(existsSync(LOCK_FILE)).toBe(true);
  });

  it("clears a stale lock and prunes", () => {
    writeFileSync(OBS_FILE, JSON.stringify(makeObs({ timestamp: Date.now() - 10 * 86400000 })) + "\n");
    writeFileSync(LOCK_FILE, "crashed-instance");
    const old = new Date(Date.now() - 30 * 60_000);
    utimesSync(LOCK_FILE, old, old);
    expect(pruneObservations(7)).toBe(true);
    expect(readLines(OBS_FILE)).toHaveLength(0);
    expect(existsSync(LOCK_FILE)).toBe(false);
  });

  it("carries over lines appended while the rewrite was in progress", () => {
    const now = Date.now();
    writeFileSync(OBS_FILE, JSON.stringify(makeObs({ timestamp: now - 10 * 86400000 })) + "\n");
    // Simulate a concurrent append landing after the snapshot read: hook the
    // partition step by appending from within JSON.parse of the old line.
    const originalParse = JSON.parse;
    let injected = false;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (!injected && text.includes("message number")) {
        injected = true;
        appendFileSync(OBS_FILE, JSON.stringify({ ...makeObs({ timestamp: now }), text: "late arrival" }) + "\n");
      }
      return originalParse(text, reviver);
    });
    try {
      expect(pruneObservations(7)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const remaining = readLines(OBS_FILE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("late arrival");
  });
});
