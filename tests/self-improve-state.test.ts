import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "fs";

const { testDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  return { testDir: mkdtempSync(join(tmpdir(), "aria-state-test-")) };
});

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: testDir,
  GITHUB_REPO: "holoduke/myagent",
}));

import {
  forcedReflectsOn,
  withForcedReflect,
  getForcedReflectsToday,
  recordForcedReflect,
  setWorkerPid,
  getWorkerPid,
  recordLastMerge,
  getLastMerge,
  markShaReverted,
  wasShaReverted,
  loadSelfImproveState,
} from "../backend/self-improve-state.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("forced reflect counter (pure)", () => {
  const state = { nudge: { date: "2026-09-05", forcedReflects: 2 }, revertedShas: [] };

  it("reads the count only for the recorded day", () => {
    expect(forcedReflectsOn(state, "2026-09-05")).toBe(2);
    expect(forcedReflectsOn(state, "2026-09-06")).toBe(0);
  });

  it("increments immutably and rolls over on a new day", () => {
    const next = withForcedReflect(state, "2026-09-05");
    expect(next.nudge.forcedReflects).toBe(3);
    expect(state.nudge.forcedReflects).toBe(2);
    expect(withForcedReflect(state, "2026-09-06").nudge).toEqual({ date: "2026-09-06", forcedReflects: 1 });
  });
});

describe("persisted state", () => {
  it("starts empty and persists forced reflects per day", () => {
    expect(getForcedReflectsToday("2026-09-05")).toBe(0);
    expect(recordForcedReflect("2026-09-05")).toBe(1);
    expect(recordForcedReflect("2026-09-05")).toBe(2);
    expect(getForcedReflectsToday("2026-09-05")).toBe(2);
    expect(getForcedReflectsToday("2026-09-06")).toBe(0);
  });

  it("stores and clears the worker pid without losing other fields", () => {
    setWorkerPid(4242);
    expect(getWorkerPid()).toBe(4242);
    expect(getForcedReflectsToday("2026-09-05")).toBe(2);
    setWorkerPid(undefined);
    expect(getWorkerPid()).toBeUndefined();
    expect("workerPid" in loadSelfImproveState()).toBe(false);
  });

  it("records the last merge and reverted shas idempotently", () => {
    const record = { prNumber: 7, prUrl: "https://github.com/holoduke/myagent/pull/7", mergeSha: "abc1234def", mergedAt: 1 };
    recordLastMerge(record);
    expect(getLastMerge()).toEqual(record);
    expect(wasShaReverted("abc1234def")).toBe(false);
    markShaReverted("abc1234def");
    markShaReverted("abc1234def");
    expect(wasShaReverted("abc1234def")).toBe(true);
    expect(loadSelfImproveState().revertedShas).toEqual(["abc1234def"]);
  });
});
