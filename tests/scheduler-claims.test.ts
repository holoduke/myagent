import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/test-brain-scheduler-claims" }));
vi.mock("../backend/utils/file-store.js", () => ({
  safeReadJSON: (_p: string, fallback: unknown) => fallback,
  atomicWriteJSON: () => {},
  ensureDir: () => {},
}));
vi.mock("../backend/contact-whitelist.js", () => ({
  isWhitelisted: () => true,
  resolveCanonicalJid: (jid: string) => jid,
}));

import { reconcileClaims } from "../backend/scheduler.js";
import type { InFlightEntry } from "../backend/scheduler.js";

const MIN = 60_000;
const NOW = 10_000 * MIN;
const ME = "host-1-aaaa";
const OTHER = "host-2-bbbb";

describe("reconcileClaims", () => {
  it("claims wanted ids that nobody holds", () => {
    const r = reconcileClaims([], ["a", "b"], ME, NOW);
    expect(r.claimed).toEqual(["a", "b"]);
    expect(r.skipped).toEqual([]);
    expect(r.entries).toEqual([
      { id: "a", startedAt: NOW, instanceId: ME },
      { id: "b", startedAt: NOW, instanceId: ME },
    ]);
  });

  it("skips ids claimed by another live instance within the TTL", () => {
    const entries: InFlightEntry[] = [{ id: "a", startedAt: NOW - 1 * MIN, instanceId: OTHER }];
    const r = reconcileClaims(entries, ["a", "b"], ME, NOW);
    expect(r.skipped).toEqual(["a"]);
    expect(r.claimed).toEqual(["b"]);
    expect(r.entries).toContainEqual(entries[0]);
  });

  it("takes over ids whose foreign claim expired (> 2 min)", () => {
    const entries: InFlightEntry[] = [{ id: "a", startedAt: NOW - 3 * MIN, instanceId: OTHER }];
    const r = reconcileClaims(entries, ["a"], ME, NOW);
    expect(r.claimed).toEqual(["a"]);
    expect(r.entries).toEqual([{ id: "a", startedAt: NOW, instanceId: ME }]);
  });

  it("treats legacy entries without an instance id as foreign claims", () => {
    const entries: InFlightEntry[] = [{ id: "a", startedAt: NOW - 30_000 }];
    expect(reconcileClaims(entries, ["a"], ME, NOW).skipped).toEqual(["a"]);
  });

  it("keeps our own live claims without duplicating them and expires our stale ones", () => {
    const entries: InFlightEntry[] = [
      { id: "a", startedAt: NOW - 1 * MIN, instanceId: ME },
      { id: "old", startedAt: NOW - 7 * MIN, instanceId: ME },
    ];
    const r = reconcileClaims(entries, ["a"], ME, NOW);
    expect(r.claimed).toEqual(["a"]);
    expect(r.entries).toEqual([{ id: "a", startedAt: NOW - 1 * MIN, instanceId: ME }]);
  });

  it("with no wanted ids only prunes expired entries (boot recovery)", () => {
    const entries: InFlightEntry[] = [
      { id: "fresh", startedAt: NOW - 1 * MIN, instanceId: OTHER },
      { id: "stale", startedAt: NOW - 5 * MIN, instanceId: OTHER },
    ];
    const r = reconcileClaims(entries, [], ME, NOW);
    expect(r.entries.map(e => e.id)).toEqual(["fresh"]);
    expect(r.claimed).toEqual([]);
  });

  it("does not mutate the input entries", () => {
    const entries: InFlightEntry[] = [{ id: "a", startedAt: NOW - 1 * MIN, instanceId: OTHER }];
    const copy = JSON.parse(JSON.stringify(entries));
    reconcileClaims(entries, ["a", "b"], ME, NOW);
    expect(entries).toEqual(copy);
  });
});
