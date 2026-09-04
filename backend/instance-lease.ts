/**
 * Single-instance lease — a heartbeat lock file on the shared /data volume.
 *
 * During rolling deploys two containers share /data and the same WhatsApp
 * session for 1-3 minutes. The lease decides which one is ACTIVE (brain,
 * pollers, WhatsApp) and which one stays PASSIVE (HTTP only) until the lock
 * is released, goes stale, or the takeover cap expires.
 *
 * Lock file: `${BRAIN_DIR}/instance.lock`
 *   { pid, instanceId, startedAt, heartbeatAt, releasedAt? }
 *
 * The pure decision helpers (`inspectLock`, `decideWait`) are exported for
 * unit tests; `createInstanceLease` wires them to the filesystem and timers.
 */

import { existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { atomicWriteJSON } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("instance-lease");

export const LOCK_HEARTBEAT_MS = 10_000;
export const LOCK_STALE_MS = 45_000;
export const LOCK_POLL_MS = 3_000;
export const LOCK_TAKEOVER_CAP_MS = 180_000;

export interface InstanceLock {
  pid: number;
  instanceId: string;
  startedAt: number;
  heartbeatAt: number;
  /** Set when the holder released the lock cleanly. */
  releasedAt?: number;
}

/**
 * - `none`     no lock file at all (fresh volume, or a legacy instance that
 *              predates the lease — cannot tell which)
 * - `released` the previous holder shut down cleanly
 * - `mine`     held by this instance
 * - `held`     held by another instance with a fresh heartbeat
 * - `stale`    held by another instance whose heartbeat is too old
 */
export type LockVerdict = "none" | "released" | "mine" | "held" | "stale";

export type WaitDecision =
  | { action: "acquire"; reason: LockVerdict }
  | { action: "takeover"; waitedMs: number }
  | { action: "wait"; verdict: LockVerdict };

export interface LeaseOptions {
  lockPath?: string;
  instanceId?: string;
  heartbeatMs?: number;
  staleMs?: number;
  pollMs?: number;
  takeoverCapMs?: number;
  now?: () => number;
}

// ── Pure helpers ──

export function isInstanceLock(value: unknown): value is InstanceLock {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.pid === "number"
    && typeof v.instanceId === "string"
    && typeof v.startedAt === "number"
    && typeof v.heartbeatAt === "number"
    && (v.releasedAt === undefined || typeof v.releasedAt === "number");
}

export function inspectLock(
  lock: InstanceLock | null,
  selfId: string,
  now: number,
  staleMs: number = LOCK_STALE_MS,
): LockVerdict {
  if (!lock) return "none";
  if (lock.instanceId === selfId) return "mine";
  if (lock.releasedAt !== undefined) return "released";
  return now - lock.heartbeatAt > staleMs ? "stale" : "held";
}

/** Decide what a waiting (passive) instance should do on this poll. */
export function decideWait(
  verdict: LockVerdict,
  waitedMs: number,
  takeoverCapMs: number = LOCK_TAKEOVER_CAP_MS,
): WaitDecision {
  if (verdict !== "held") return { action: "acquire", reason: verdict };
  if (waitedMs >= takeoverCapMs) return { action: "takeover", waitedMs };
  return { action: "wait", verdict };
}

// ── File IO ──

export function readLockFile(lockPath: string): InstanceLock | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (isInstanceLock(parsed)) return parsed;
    log.warn(`Lock file ${lockPath} has an unexpected shape — treating as absent`);
    return null;
  } catch (err) {
    log.warn(`Lock file ${lockPath} unreadable (${err}) — treating as absent`);
    return null;
  }
}

function writeLockFile(lockPath: string, lock: InstanceLock): void {
  atomicWriteJSON(lockPath, lock, 0);
}

/** Claim the lock for a non-wait decision and name the outcome. */
function applyDecision(
  decision: Exclude<WaitDecision, { action: "wait" }>,
  claim: (reason: string) => void,
): WaitOutcome {
  if (decision.action === "acquire") {
    claim(`lock ${decision.reason}`);
    return "acquired";
  }
  log.warn(`Lease TAKEOVER after ${Math.round(decision.waitedMs / 1000)}s — holder never released`);
  claim("takeover cap");
  return "takeover";
}

// ── Lease ──

export type LeaseMode = "passive" | "active";
export type WaitOutcome = "acquired" | "takeover" | "cancelled";

export interface InstanceLease {
  readonly instanceId: string;
  readonly mode: LeaseMode;
  /** Try once; returns true when this instance now holds the lock. */
  tryAcquire(): boolean;
  /** Poll until acquired or forced takeover; "cancelled" if released meanwhile. */
  waitForLease(): Promise<WaitOutcome>;
  /** Stop the heartbeat / wait and mark the lock released (only if we hold it). */
  release(): void;
  /** Current verdict for diagnostics. */
  inspect(): LockVerdict;
}

export function createInstanceLease(opts: LeaseOptions = {}): InstanceLease {
  const lockPath = opts.lockPath ?? `${BRAIN_DIR}/instance.lock`;
  const instanceId = opts.instanceId ?? randomUUID();
  const heartbeatMs = opts.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const takeoverCapMs = opts.takeoverCapMs ?? LOCK_TAKEOVER_CAP_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();

  let mode: LeaseMode = "passive";
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelWait: (() => void) | null = null;

  const inspect = (): LockVerdict => inspectLock(readLockFile(lockPath), instanceId, now(), staleMs);

  const ownLock = (): InstanceLock => ({
    pid: process.pid,
    instanceId,
    startedAt,
    heartbeatAt: now(),
  });

  const beat = (): void => {
    const verdict = inspect();
    if (verdict === "held") {
      log.warn(`Heartbeat: lock at ${lockPath} is now held by another instance — this instance may have been taken over`);
      return;
    }
    try {
      writeLockFile(lockPath, ownLock());
    } catch (err) {
      log.error(`Heartbeat write failed: ${err}`);
    }
  };

  const claim = (reason: string): void => {
    writeLockFile(lockPath, ownLock());
    mode = "active";
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(beat, heartbeatMs);
    heartbeat.unref();
    log.info(`Lease ACQUIRED (${reason}) instance=${instanceId} pid=${process.pid} lock=${lockPath}`);
  };

  const tryAcquire = (): boolean => {
    const verdict = inspect();
    if (verdict === "held") return false;
    claim(verdict);
    return true;
  };

  const waitForLease = (): Promise<WaitOutcome> =>
    new Promise((resolve) => {
      const waitStart = now();
      let lastVerdict: LockVerdict | null = null;
      cancelWait = () => resolve("cancelled");
      const finish = (outcome: WaitOutcome): void => {
        cancelWait = null;
        resolve(outcome);
      };

      const poll = (): void => {
        waitTimer = null;
        const verdict = inspect();
        const decision = decideWait(verdict, now() - waitStart, takeoverCapMs);
        if (decision.action !== "wait") {
          finish(applyDecision(decision, claim));
          return;
        }
        if (verdict !== lastVerdict) {
          log.info(`Lease PASSIVE — lock ${verdict}, polling every ${pollMs / 1000}s (cap ${takeoverCapMs / 1000}s)`);
          lastVerdict = verdict;
        }
        waitTimer = setTimeout(poll, pollMs);
      };

      poll();
    });

  const release = (): void => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    const wasActive = mode === "active";
    mode = "passive";
    if (cancelWait) {
      cancelWait();
      cancelWait = null;
    }
    if (!wasActive) return;
    try {
      const current = readLockFile(lockPath);
      if (current && current.instanceId === instanceId) {
        writeLockFile(lockPath, { ...current, releasedAt: now() });
        log.info(`Lease RELEASED instance=${instanceId}`);
      } else {
        log.warn(`Lease release skipped — lock no longer ours`);
      }
    } catch (err) {
      log.error(`Lease release failed: ${err}`);
    }
  };

  return {
    instanceId,
    get mode() { return mode; },
    tryAcquire,
    waitForLease,
    release,
    inspect,
  };
}
