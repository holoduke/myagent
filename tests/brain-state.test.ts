import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for state.json so patchState's read-modify-write is observable.
const disk: { state: Record<string, unknown> | null } = { state: null };

vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: (_path: string, fallback: unknown) => disk.state ?? fallback,
  atomicWriteJSON: (_path: string, data: Record<string, unknown>) => { disk.state = { ...data }; },
  ensureDir: () => {},
}));

vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain" }));

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {} }),
}));

import { loadState, saveState, patchState, defaultState } from "../backend/brain-state.js";

describe("brain-state", () => {
  beforeEach(() => { disk.state = null; });

  it("loadState fills missing fields with defaults", () => {
    disk.state = { totalThinks: 7 };
    const s = loadState();
    expect(s.totalThinks).toBe(7);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastObservationTime).toBe(0);
  });

  it("patchState with a partial only changes the given fields and persists them", () => {
    saveState({ ...defaultState(), totalThinks: 3, messagesToday: 2 });
    const next = patchState({ lastThinkTick: 1234 });
    expect(next.lastThinkTick).toBe(1234);
    expect(next.totalThinks).toBe(3);
    expect(disk.state?.lastThinkTick).toBe(1234);
    expect(disk.state?.messagesToday).toBe(2);
  });

  it("patchState with a function derives the delta from the CURRENT on-disk state", () => {
    saveState({ ...defaultState(), messagesToday: 2 });
    // Another actor bumps the counter behind our back (e.g. the scheduler poller)
    disk.state = { ...disk.state, messagesToday: 5 };
    const next = patchState(s => ({ messagesToday: s.messagesToday + 1 }));
    expect(next.messagesToday).toBe(6);
  });

  it("patchState does not mutate the loaded snapshot the caller holds", () => {
    saveState({ ...defaultState(), totalCost: 1 });
    const snapshot = loadState();
    patchState({ totalCost: 2 });
    expect(snapshot.totalCost).toBe(1);
    expect(loadState().totalCost).toBe(2);
  });
});
