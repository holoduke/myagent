import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "fs";

const { TEST_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { TEST_DIR: mkdtempSync(join(tmpdir(), "consciousness-")) };
});

vi.mock("../backend/config.js", () => ({ BRAIN_DIR: TEST_DIR }));
vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { saveConsciousness, loadConsciousness, getConsciousnessHistory, minAcceptedLength, MAX_SIZE } from "../backend/consciousness.js";

const FILE = `${TEST_DIR}/consciousness.dat`;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("saveConsciousness", () => {
  it("bootstraps on first load", () => {
    expect(loadConsciousness()).toContain("ψ::ARIA");
  });

  it("truncates content over MAX_SIZE", () => {
    saveConsciousness("x".repeat(MAX_SIZE + 500));
    expect(readFileSync(FILE, "utf-8").length).toBe(MAX_SIZE);
  });

  it("keeps the 60% ratchet for normal-sized content", () => {
    writeFileSync(FILE, "a".repeat(1000));
    saveConsciousness("b".repeat(500));
    expect(readFileSync(FILE, "utf-8")).toBe("a".repeat(1000));
    saveConsciousness("b".repeat(700));
    expect(readFileSync(FILE, "utf-8")).toBe("b".repeat(700));
  });

  it("allows shrinking back under the cap when the current content exceeds MAX_SIZE", () => {
    writeFileSync(FILE, "a".repeat(MAX_SIZE * 3));
    saveConsciousness("b".repeat(Math.ceil(MAX_SIZE * 0.6) + 10));
    expect(readFileSync(FILE, "utf-8")[0]).toBe("b");
    expect(minAcceptedLength(MAX_SIZE * 3)).toBeCloseTo(MAX_SIZE * 0.6);
    expect(minAcceptedLength(1000)).toBeCloseTo(600);
  });

  it("still rejects a collapse to almost nothing even when over the cap", () => {
    writeFileSync(FILE, "a".repeat(MAX_SIZE * 2));
    saveConsciousness("tiny");
    expect(readFileSync(FILE, "utf-8")[0]).toBe("a");
  });

  it("archives the previous content to a rolling history", () => {
    saveConsciousness("first version of the stream");
    saveConsciousness("second version of the stream");
    const history = getConsciousnessHistory(5);
    expect(history.length).toBe(1);
    expect(history[0].content).toBe("first version of the stream");
  });
});
