import { describe, it, expect, afterAll, vi } from "vitest";
import { rmSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

const { dir, legacyFile } = vi.hoisted(() => {
  const { mkdtempSync, writeFileSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  const dir = mkdtempSync(join(tmpdir(), "history-"));
  const legacyFile = join(dir, "chat-history.json");
  writeFileSync(legacyFile, JSON.stringify([
    { role: "user", content: "legacy hello", timestamp: 1, source: "web" },
    { role: "assistant", content: "legacy reply", timestamp: 2, source: "web", stats: { durationMs: 10, totalCostUsd: 0.01, inputTokens: 5, outputTokens: 5, numTurns: 1 } },
  ]));
  process.env.HISTORY_FILE = legacyFile;
  return { dir, legacyFile };
});

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {} }),
}));

import { getHistory, addMessage, clearHistory, getUsageData, getRecentConversationRecap } from "../backend/history.js";
import type { ChatMessage } from "../backend/history.js";

const LOG_FILE = legacyFile.replace(/\.json$/, ".jsonl");

const msg = (content: string, role: ChatMessage["role"] = "user"): ChatMessage => ({ role, content, timestamp: Date.now(), source: "whatsapp" });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("chat history log", () => {
  it("migrates the legacy snapshot into the jsonl log on first read", () => {
    const history = getHistory();
    expect(history).toHaveLength(2);
    expect(existsSync(LOG_FILE)).toBe(true);
    expect(readFileSync(LOG_FILE, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  it("appends one line per message instead of rewriting the file", () => {
    const before = readFileSync(LOG_FILE, "utf-8");
    addMessage(msg("appended"));
    const after = readFileSync(LOG_FILE, "utf-8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(3);
    expect(getHistory().at(-1)?.content).toBe("appended");
  });

  it("computes usage data from the cached history", () => {
    const usage = getUsageData();
    expect(usage.totalResponses).toBe(1);
    expect(usage.totalTokens).toBe(10);
    expect(getRecentConversationRecap()).toContain("legacy reply");
  });

  it("keeps lines another instance appended when compacting", () => {
    clearHistory(); // resets the append counter: compaction fires on the 500th append below
    for (let i = 0; i < 250; i++) addMessage(msg(`bulk ${i}`));
    appendFileSync(LOG_FILE, JSON.stringify(msg("from other instance")) + "\n");
    for (let i = 250; i < 500; i++) addMessage(msg(`bulk ${i}`));

    const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(500); // 501 lines compacted to the newest 500
    expect(lines.some(l => l.includes("from other instance"))).toBe(true);
    expect(lines[0]).toContain("bulk 1"); // oldest own line dropped, not the other instance's
    expect(getHistory()).toHaveLength(500);
    expect(getHistory().some(m => m.content === "from other instance")).toBe(true);
  });

  it("clearHistory empties the log", () => {
    clearHistory();
    expect(getHistory()).toEqual([]);
    expect(readFileSync(LOG_FILE, "utf-8")).toBe("");
    writeFileSync(legacyFile, "[]");
  });
});
