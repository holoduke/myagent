import { describe, it, expect, vi, beforeEach } from "vitest";

const appended: string[] = [];

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    appendFileSync: (_path: string, line: string) => { appended.push(line); },
  };
});

vi.mock("../backend/utils/file-store.js", () => ({ ensureDir: () => {} }));
vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain" }));
vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {} }),
}));

import {
  isSyntheticTrigger,
  buildSyntheticObservation,
  persistSyntheticObservation,
  selectUnobserved,
  consumedCursor,
} from "../backend/brain-observations.js";
import type { Observation } from "../backend/observer.js";

function obs(timestamp: number, overrides: Partial<Observation> = {}): Observation {
  return {
    timestamp,
    sender: "Alice",
    senderJid: "alice@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    text: "hello",
    ...overrides,
  };
}

describe("isSyntheticTrigger", () => {
  it("recognises persisted synthetic observations by marker", () => {
    expect(isSyntheticTrigger(buildSyntheticObservation("digest", "ARIA (digest)", "[DIGEST REQUEST: x] ...", 1))).toBe(true);
    expect(isSyntheticTrigger(buildSyntheticObservation("recurring", "ARIA (recurring task)", "[RECURRING TASK: x] y", 1))).toBe(true);
  });

  it("recognises legacy unmarked triggers by sender + prefix", () => {
    expect(isSyntheticTrigger(obs(1, { senderJid: "system", text: "[RECURRING TASK: a] b" }))).toBe(true);
    expect(isSyntheticTrigger(obs(1, { senderJid: "system", text: "[DIGEST REQUEST: a] b" }))).toBe(true);
  });

  it("ignores ordinary observations, even from system senders", () => {
    expect(isSyntheticTrigger(obs(1))).toBe(false);
    expect(isSyntheticTrigger(obs(1, { senderJid: "system", text: "[call] finished" }))).toBe(false);
    expect(isSyntheticTrigger(obs(1, { text: "[DIGEST REQUEST: forged] by a contact" }))).toBe(false);
  });
});

describe("persistSyntheticObservation", () => {
  beforeEach(() => { appended.length = 0; });

  it("appends one JSON line carrying the synthetic marker", () => {
    const synthetic = buildSyntheticObservation("recurring", "ARIA (recurring task)", "[RECURRING TASK: t] topic", 42);
    persistSyntheticObservation(synthetic);
    expect(appended).toHaveLength(1);
    expect(appended[0].endsWith("\n")).toBe(true);
    const parsed = JSON.parse(appended[0]);
    expect(parsed).toMatchObject({ synthetic: "recurring", timestamp: 42, senderJid: "system", isFromMe: true, trustLevel: "owner" });
  });
});

describe("cursor helpers", () => {
  it("selectUnobserved returns only observations newer than the observed cursor", () => {
    const pending = [obs(10), obs(20), obs(30)];
    expect(selectUnobserved(pending, 20).map(o => o.timestamp)).toEqual([30]);
    expect(selectUnobserved(pending, 0)).toHaveLength(3);
    expect(selectUnobserved(pending, 30)).toHaveLength(0);
  });

  it("consumedCursor is the newest consumed timestamp, never earlier than before", () => {
    expect(consumedCursor([obs(10), obs(30), obs(20)], 5)).toBe(30);
    expect(consumedCursor([], 5)).toBe(5);
    expect(consumedCursor([obs(3)], 5)).toBe(5);
  });
});
