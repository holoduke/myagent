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
 * It does not restart anything — humans must decide whether to restart the process.
 *
 * ALERT escalation: log lines alone proved insufficient (the jun–aug 2026 outage
 * went unnoticed for ~10 weeks because every other degradation signal routes
 * through the failing Claude API path). When an ALERT fires and `ownerJid` is
 * configured, the watchdog also appends a plain-text message to the
 * scheduled-messages queue — delivered by the scheduler's own 60s poll loop,
 * which needs no Claude API call and thus survives an API outage.
 * Dedupe: at most one alert per 24h while the condition persists (persisted in
 * watchdog-state.json so restarts don't re-alert), plus one "recovered" notice
 * when the watchdog clears after having notified.
 */

import { createLogger } from "./logger.js";
import { safeReadJSON, atomicWriteJSON } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { scheduleMessage, getScheduledMessages, markDelivered } from "./scheduler.js";
import type { TickFailureSummary } from "./memory/types.js";

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
  /**
   * WhatsApp JID to escalate ALERTs to via the scheduled-messages queue.
   * When omitted, the watchdog is log-only (pre-escalation behavior).
   */
  ownerJid?: string;
  /**
   * Function returning the persisted summary of the last tick failure, or null
   * when none is relevant. When provided, the ALERT message names the failure
   * ("laatste fout: ...") instead of only pointing at dashboard/logs.
   */
  getLastTickFailure?: () => TickFailureSummary | null;
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

// ── ALERT escalation via the scheduled-messages queue ──

const WATCHDOG_STATE_FILE = `${BRAIN_DIR}/watchdog-state.json`;
const ALERT_RENOTIFY_MS = 24 * 60 * 60 * 1000; // at most one alert per 24h while the condition persists
const WATCHDOG_SOURCE = "watchdog";

interface WatchdogNotifyState {
  /** Epoch ms of the last alert queued for delivery; 0 = never. */
  lastAlertNotifiedAt: number;
  /** True from the moment an alert is queued until the recovery notice is queued. */
  alertNotified: boolean;
}

function loadNotifyState(): WatchdogNotifyState {
  return safeReadJSON<WatchdogNotifyState>(WATCHDOG_STATE_FILE, {
    lastAlertNotifiedAt: 0,
    alertNotified: false,
  });
}

function saveNotifyState(state: WatchdogNotifyState): void {
  atomicWriteJSON(WATCHDOG_STATE_FILE, state);
}

/** An undelivered watchdog message still sits in the queue (delivery removes entries). */
function hasQueuedWatchdogMessage(): boolean {
  try {
    return getScheduledMessages().some((m) => m.source === WATCHDOG_SOURCE);
  } catch (err) {
    log(`Could not inspect schedule for existing watchdog entries: ${err}`);
    return true; // fail closed — better to skip a notify than to queue duplicates
  }
}

/**
 * Format the last tick failure as a message suffix, e.g.
 * " — laatste fout: [think] API timeout (transient, 6x)". Empty string when
 * there is no failure to report. Truncated so the full alert stays well under
 * ~300 chars.
 */
export function formatFailureSuffix(failure: TickFailureSummary | null | undefined): string {
  if (!failure) return "";
  const msg = failure.message.length > 140 ? `${failure.message.slice(0, 137)}...` : failure.message;
  const kind = failure.transient ? "transient" : "permanent";
  return ` — laatste fout: [${failure.phase}] ${msg} (${kind}, ${failure.consecutiveFailures}x)`;
}

function escalateAlert(
  ownerJid: string,
  msSinceSuccess: number,
  getLastTickFailure?: () => TickFailureSummary | null,
): void {
  try {
    const state = loadNotifyState();
    if (state.alertNotified && Date.now() - state.lastAlertNotifiedAt < ALERT_RENOTIFY_MS) return;
    if (hasQueuedWatchdogMessage()) return;
    const hours = Math.round(msSinceSuccess / 3600000);
    let failureSuffix = "";
    try {
      failureSuffix = formatFailureSuffix(getLastTickFailure?.());
    } catch (err) {
      // Diagnostics must never block the alert itself.
      log(`Could not read last tick failure for alert: ${err}`);
    }
    scheduleMessage(
      ownerJid,
      `aria heartbeat: geen succesvolle brain tick in ${hours}h${failureSuffix || " — check dashboard/logs"}`,
      Date.now(),
      WATCHDOG_SOURCE,
    );
    saveNotifyState({ lastAlertNotifiedAt: Date.now(), alertNotified: true });
    log(`ALERT escalated to scheduled-messages queue for ${ownerJid}`);
  } catch (err) {
    // The watchdog must never take down its own interval — log and retry next check.
    log(`Failed to escalate ALERT via scheduler: ${err}`);
  }
}

function notifyRecovered(ownerJid: string): void {
  try {
    const state = loadNotifyState();
    if (!state.alertNotified) return;
    const undelivered = getScheduledMessages().filter((m) => m.source === WATCHDOG_SOURCE);
    if (undelivered.length > 0) {
      // The alert never reached Gillis — retract it rather than delivering a
      // stale alert followed by a recovery notice.
      markDelivered(undelivered.map((m) => m.id));
      log(`Recovery: retracted ${undelivered.length} undelivered watchdog alert(s) from the queue`);
    } else {
      scheduleMessage(
        ownerJid,
        "aria heartbeat: hersteld — brain tick weer succesvol",
        Date.now(),
        WATCHDOG_SOURCE,
      );
      log(`Recovery notice queued for ${ownerJid}`);
    }
    saveNotifyState({ ...state, alertNotified: false });
  } catch (err) {
    log(`Failed to queue recovery notice: ${err}`);
  }
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
      if (opts.ownerJid) escalateAlert(opts.ownerJid, status.msSinceSuccess, opts.getLastTickFailure);
    } else if (status.level === "warn" && lastLoggedLevel !== "warn" && lastLoggedLevel !== "alert") {
      log(`WARN: no successful tick in ${Math.round(status.msSinceSuccess / 60000)}m`);
      lastLoggedLevel = "warn";
    } else if (status.level === "ok") {
      if (lastLoggedLevel !== "ok") {
        log(`Watchdog cleared — brain ticked successfully`);
        lastLoggedLevel = "ok";
      }
      // Checked every tick (not just on level transitions): recovery usually
      // happens via a process restart, which resets lastLoggedLevel to "ok".
      // notifyRecovered no-ops unless the persisted alertNotified flag is set.
      if (opts.ownerJid) notifyRecovered(opts.ownerJid);
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
