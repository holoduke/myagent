/**
 * Brain watchdog — detects stalled or silent ticks.
 *
 * The brain runs on a tick loop with a circuit breaker that backs off on
 * consecutive failures. Without this watchdog, the brain can enter a 30-minute
 * silent backoff, and an operator has no way to know unless they tail logs.
 *
 * The watchdog runs on its own interval, reads the last-successful-tick timestamp
 * from disk, and emits an escalating log line when too much time has elapsed:
 *  - WARN  if no successful tick in `warnAfterMs`  (default 1h)
 *  - ALERT if no successful tick in `alertAfterMs` (default 4h, > consolidate interval)
 *
 * It does not take action — humans must decide whether to restart the process.
 */

import { createLogger } from "./logger.js";

const log = createLogger("watchdog");

const DEFAULT_WARN_AFTER_MS = 60 * 60 * 1000;        // 1h
const DEFAULT_ALERT_AFTER_MS = 4 * 60 * 60 * 1000;   // 4h
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;     // 5min

export interface WatchdogOptions {
  /** Minimum ms since lastSuccessfulTick before a WARN is logged. */
  warnAfterMs?: number;
  /** Minimum ms since lastSuccessfulTick before an ALERT is logged. */
  alertAfterMs?: number;
  /** How often the watchdog checks. */
  checkIntervalMs?: number;
  /** Function returning the latest brain state. Lets us avoid an import cycle. */
  getLastSuccessfulTick: () => number;
  /** Function returning whether the brain is enabled — disabled brains don't get warned about. */
  isBrainEnabled: () => boolean;
}

export interface WatchdogStatus {
  level: "ok" | "warn" | "alert";
  msSinceSuccess: number;
}

/**
 * Pure check used both by the interval and by tests. Returns the warning level
 * given the elapsed time and thresholds.
 */
export function evaluateWatchdog(
  msSinceSuccess: number,
  warnAfterMs: number,
  alertAfterMs: number,
): WatchdogStatus {
  if (msSinceSuccess >= alertAfterMs) return { level: "alert", msSinceSuccess };
  if (msSinceSuccess >= warnAfterMs) return { level: "warn", msSinceSuccess };
  return { level: "ok", msSinceSuccess };
}

let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let lastLoggedLevel: "ok" | "warn" | "alert" = "ok";

export function startWatchdog(opts: WatchdogOptions): void {
  if (watchdogInterval) {
    log("Watchdog already running, ignoring duplicate start");
    return;
  }
  const warnAfterMs = opts.warnAfterMs ?? DEFAULT_WARN_AFTER_MS;
  const alertAfterMs = opts.alertAfterMs ?? DEFAULT_ALERT_AFTER_MS;
  const checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  log(`Watchdog started (warn=${Math.round(warnAfterMs / 60000)}m, alert=${Math.round(alertAfterMs / 60000)}m, check=${Math.round(checkIntervalMs / 60000)}m)`);

  watchdogInterval = setInterval(() => {
    if (!opts.isBrainEnabled()) return;
    const lastSuccess = opts.getLastSuccessfulTick();
    if (lastSuccess <= 0) return; // brain hasn't had a successful tick yet
    const status = evaluateWatchdog(Date.now() - lastSuccess, warnAfterMs, alertAfterMs);

    // Only log when the level changes or when we're at alert (re-emit hourly via natural cadence).
    if (status.level === "alert") {
      log(`!! ALERT: no successful tick in ${Math.round(status.msSinceSuccess / 60000)}m — brain may be stalled`);
      lastLoggedLevel = "alert";
    } else if (status.level === "warn" && lastLoggedLevel !== "warn" && lastLoggedLevel !== "alert") {
      log(`WARN: no successful tick in ${Math.round(status.msSinceSuccess / 60000)}m`);
      lastLoggedLevel = "warn";
    } else if (status.level === "ok" && lastLoggedLevel !== "ok") {
      log(`Watchdog cleared — brain ticked successfully`);
      lastLoggedLevel = "ok";
    }
  }, checkIntervalMs);
}

export function stopWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    lastLoggedLevel = "ok";
    log("Watchdog stopped");
  }
}
