import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: "/tmp/test-brain",
  GITHUB_REPO: "holoduke/myagent",
}));

import {
  parsePrNumber,
  isAriaBranch,
  mergeBackoffMs,
  evaluateMergeGates,
  isQuietHour,
  outputTail,
  MAX_MERGE_ATTEMPTS,
} from "../backend/self-improve-merge.js";

describe("parsePrNumber", () => {
  it("accepts a PR URL for the configured repo", () => {
    expect(parsePrNumber("https://github.com/holoduke/myagent/pull/374")).toBe(374);
  });

  it("rejects other repos, paths, schemes and trailing junk", () => {
    expect(parsePrNumber("https://github.com/evil/myagent/pull/1")).toBeNull();
    expect(parsePrNumber("https://github.com/holoduke/myagent/pulls")).toBeNull();
    expect(parsePrNumber("http://github.com/holoduke/myagent/pull/1")).toBeNull();
    expect(parsePrNumber("https://github.com/holoduke/myagent/pull/1/files")).toBeNull();
    expect(parsePrNumber("https://github.com/holoduke/myagent/pull/1 && rm -rf /")).toBeNull();
  });

  it("returns null when no repo is configured", () => {
    expect(parsePrNumber("https://github.com/holoduke/myagent/pull/1", "")).toBeNull();
  });

  it("escapes regex metacharacters in the repo name", () => {
    expect(parsePrNumber("https://github.com/holo.duke/my-agent/pull/2", "holo.duke/my-agent")).toBe(2);
    expect(parsePrNumber("https://github.com/holoXduke/my-agent/pull/2", "holo.duke/my-agent")).toBeNull();
  });
});

describe("isAriaBranch", () => {
  it("only accepts aria/ prefixed branch names", () => {
    expect(isAriaBranch("aria/fix-thing")).toBe(true);
    expect(isAriaBranch("aria/revert-abc12345")).toBe(true);
    expect(isAriaBranch("main")).toBe(false);
    expect(isAriaBranch("aria")).toBe(false);
    expect(isAriaBranch("feature/aria/x")).toBe(false);
    expect(isAriaBranch("aria/has space")).toBe(false);
  });
});

describe("mergeBackoffMs", () => {
  it("waits 0 / 15m / 60m for attempts 1 / 2 / 3 and caps afterwards", () => {
    expect(mergeBackoffMs(1)).toBe(0);
    expect(mergeBackoffMs(2)).toBe(15 * 60 * 1000);
    expect(mergeBackoffMs(3)).toBe(60 * 60 * 1000);
    expect(mergeBackoffMs(9)).toBe(60 * 60 * 1000);
    expect(mergeBackoffMs(0)).toBe(0);
  });

  it("allows one initial attempt and two retries", () => {
    expect(MAX_MERGE_ATTEMPTS).toBe(3);
  });
});

describe("isQuietHour", () => {
  it("handles overnight and same-day ranges", () => {
    expect(isQuietHour(23, 23, 7)).toBe(true);
    expect(isQuietHour(3, 23, 7)).toBe(true);
    expect(isQuietHour(7, 23, 7)).toBe(false);
    expect(isQuietHour(12, 8, 22)).toBe(true);
    expect(isQuietHour(23, 8, 22)).toBe(false);
    expect(isQuietHour(12, 0, 0)).toBe(false);
  });
});

describe("evaluateMergeGates", () => {
  const cfg = {
    selfImproveAutoMerge: true,
    selfImproveMaxPerDay: 6,
    selfImproveMinMergeIntervalMs: 2 * 60 * 60 * 1000,
    quietStart: 23,
    quietEnd: 7,
  };
  const now = 1_000_000_000_000;
  const base = { cfg, ownerHour: 12, dailyAttempts: 0, lastMergeAt: 0, now };

  it("allows a merge when every gate is open", () => {
    expect(evaluateMergeGates(base)).toEqual({ allowed: true });
  });

  it("refuses when auto-merge is disabled, even for recovery", () => {
    const r = evaluateMergeGates({ ...base, cfg: { ...cfg, selfImproveAutoMerge: false }, isRecovery: true });
    expect(r.allowed).toBe(false);
  });

  it("refuses during quiet hours", () => {
    const r = evaluateMergeGates({ ...base, ownerHour: 2 });
    expect(r).toMatchObject({ allowed: false });
    expect((r as { reason: string }).reason).toMatch(/quiet/);
  });

  it("refuses once the daily budget is used up", () => {
    const r = evaluateMergeGates({ ...base, dailyAttempts: 6 });
    expect((r as { reason: string }).reason).toMatch(/daily budget/);
  });

  it("enforces spacing between merges", () => {
    const r = evaluateMergeGates({ ...base, lastMergeAt: now - 30 * 60 * 1000 });
    expect((r as { reason: string }).reason).toMatch(/wait 90m/);
    expect(evaluateMergeGates({ ...base, lastMergeAt: now - 2 * 60 * 60 * 1000 })).toEqual({ allowed: true });
  });

  it("lets recovery reverts bypass quiet hours, budget and spacing", () => {
    const r = evaluateMergeGates({ ...base, ownerHour: 2, dailyAttempts: 99, lastMergeAt: now - 1000, isRecovery: true });
    expect(r).toEqual({ allowed: true });
  });
});

describe("outputTail", () => {
  it("keeps short output intact and truncates long output from the front", () => {
    expect(outputTail("short", 10)).toBe("short");
    expect(outputTail("abcdefghij", 4)).toBe("…ghij");
  });
});
