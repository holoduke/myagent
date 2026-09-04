import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign(
    (..._args: unknown[]) => {},
    { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ),
}));

vi.mock("../backend/config.js", () => ({ BRAIN_DIR: "/tmp/unused-brain" }));

import {
  inspectLock,
  decideWait,
  isInstanceLock,
  readLockFile,
  createInstanceLease,
  LOCK_STALE_MS,
  LOCK_TAKEOVER_CAP_MS,
  type InstanceLock,
} from "../backend/instance-lease.js";

const lock = (overrides: Partial<InstanceLock> = {}): InstanceLock => ({
  pid: 42,
  instanceId: "other",
  startedAt: 1_000,
  heartbeatAt: 10_000,
  ...overrides,
});

describe("inspectLock", () => {
  it("is 'none' without a lock", () => {
    expect(inspectLock(null, "me", 10_000)).toBe("none");
  });

  it("is 'mine' when the instance id matches, even if stale", () => {
    expect(inspectLock(lock({ instanceId: "me", heartbeatAt: 0 }), "me", 999_999)).toBe("mine");
  });

  it("is 'released' when the holder wrote releasedAt", () => {
    expect(inspectLock(lock({ releasedAt: 11_000 }), "me", 11_500)).toBe("released");
  });

  it("is 'held' while the heartbeat is fresh", () => {
    expect(inspectLock(lock(), "me", 10_000 + LOCK_STALE_MS)).toBe("held");
  });

  it("is 'stale' once the heartbeat is older than the stale window", () => {
    expect(inspectLock(lock(), "me", 10_000 + LOCK_STALE_MS + 1)).toBe("stale");
  });
});

describe("decideWait", () => {
  it("acquires for every verdict except 'held'", () => {
    for (const v of ["none", "released", "mine", "stale"] as const) {
      expect(decideWait(v, 0)).toEqual({ action: "acquire", reason: v });
    }
  });

  it("waits while held under the cap", () => {
    expect(decideWait("held", LOCK_TAKEOVER_CAP_MS - 1)).toEqual({ action: "wait", verdict: "held" });
  });

  it("takes over at the cap", () => {
    expect(decideWait("held", LOCK_TAKEOVER_CAP_MS)).toEqual({ action: "takeover", waitedMs: LOCK_TAKEOVER_CAP_MS });
  });
});

describe("isInstanceLock / readLockFile", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lease-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("rejects malformed shapes", () => {
    expect(isInstanceLock(null)).toBe(false);
    expect(isInstanceLock({ pid: "1", instanceId: "x", startedAt: 1, heartbeatAt: 1 })).toBe(false);
    expect(isInstanceLock(lock())).toBe(true);
  });

  it("treats a corrupt file as absent", () => {
    const path = join(dir, "instance.lock");
    writeFileSync(path, "{not json");
    expect(readLockFile(path)).toBeNull();
  });
});

describe("createInstanceLease", () => {
  let dir: string;
  let path: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "lease-"));
    path = join(dir, "instance.lock");
    clock = 100_000;
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a free lock and writes its own id", () => {
    const lease = createInstanceLease({ lockPath: path, instanceId: "a", now });
    expect(lease.tryAcquire()).toBe(true);
    expect(lease.mode).toBe("active");
    expect(readLockFile(path)?.instanceId).toBe("a");
    lease.release();
  });

  it("refuses a lock held with a fresh heartbeat", () => {
    writeFileSync(path, JSON.stringify(lock({ heartbeatAt: clock })));
    const lease = createInstanceLease({ lockPath: path, instanceId: "b", now });
    expect(lease.tryAcquire()).toBe(false);
    expect(lease.mode).toBe("passive");
  });

  it("takes a stale lock", () => {
    writeFileSync(path, JSON.stringify(lock({ heartbeatAt: clock - LOCK_STALE_MS - 1 })));
    const lease = createInstanceLease({ lockPath: path, instanceId: "b", now });
    expect(lease.tryAcquire()).toBe(true);
    expect(readLockFile(path)?.instanceId).toBe("b");
    lease.release();
  });

  it("heartbeats and releases with releasedAt so the next boot sees 'released'", () => {
    const lease = createInstanceLease({ lockPath: path, instanceId: "a", now, heartbeatMs: 1_000 });
    lease.tryAcquire();
    clock += 5_000;
    vi.advanceTimersByTime(1_000);
    expect(readLockFile(path)?.heartbeatAt).toBe(clock);

    lease.release();
    expect(lease.mode).toBe("passive");
    expect(existsSync(path)).toBe(true);
    const next = createInstanceLease({ lockPath: path, instanceId: "b", now });
    expect(next.inspect()).toBe("released");
  });

  it("does not release a lock another instance now owns", () => {
    const lease = createInstanceLease({ lockPath: path, instanceId: "a", now });
    lease.tryAcquire();
    writeFileSync(path, JSON.stringify(lock({ instanceId: "b", heartbeatAt: clock })));
    lease.release();
    expect(JSON.parse(readFileSync(path, "utf-8")).releasedAt).toBeUndefined();
  });

  it("waits while held and activates the moment the holder releases", async () => {
    writeFileSync(path, JSON.stringify(lock({ instanceId: "old", heartbeatAt: clock })));
    const lease = createInstanceLease({ lockPath: path, instanceId: "new", now, pollMs: 1_000 });
    const outcome = lease.waitForLease();

    clock += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(lease.mode).toBe("passive");

    writeFileSync(path, JSON.stringify(lock({ instanceId: "old", heartbeatAt: clock, releasedAt: clock })));
    clock += 1_000;
    vi.advanceTimersByTime(1_000);

    await expect(outcome).resolves.toBe("acquired");
    expect(readLockFile(path)?.instanceId).toBe("new");
    lease.release();
  });

  it("forces a takeover once the cap elapses", async () => {
    const holder = { write: () => writeFileSync(path, JSON.stringify(lock({ instanceId: "old", heartbeatAt: clock }))) };
    holder.write();
    const lease = createInstanceLease({ lockPath: path, instanceId: "new", now, pollMs: 1_000, takeoverCapMs: 3_000 });
    const outcome = lease.waitForLease();
    for (let i = 0; i < 3; i++) {
      clock += 1_000;
      holder.write(); // holder keeps heartbeating but never releases
      vi.advanceTimersByTime(1_000);
    }
    await expect(outcome).resolves.toBe("takeover");
    expect(readLockFile(path)?.instanceId).toBe("new");
    lease.release();
  });

  it("resolves 'cancelled' when released while waiting", async () => {
    writeFileSync(path, JSON.stringify(lock({ instanceId: "old", heartbeatAt: clock })));
    const lease = createInstanceLease({ lockPath: path, instanceId: "new", now, pollMs: 1_000 });
    const outcome = lease.waitForLease();
    lease.release();
    await expect(outcome).resolves.toBe("cancelled");
    expect(readLockFile(path)?.instanceId).toBe("old");
  });
});
