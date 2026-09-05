/**
 * Scheduled message delivery and proactive message sending.
 * Extracted from brain.ts for maintainability.
 *
 * State discipline: every counter change here goes through patchState (a
 * read-modify-write at the moment of change). The 10s scheduler poller and
 * the long-running tick loop write the same state.json, so a whole-snapshot
 * save from either side would revert the other's changes.
 */

import { createLogger } from "./logger.js";
import { getDueMessages, getScheduledMessages, markDelivered, markFailed, getRecentDeliveries, logDelivery, scheduleMessage, DEDUP_WINDOW_MS } from "./scheduler.js";
import { isWhatsAppConnected } from "./integrations/whatsapp.js";
import { verify } from "./action-verifier.js";
import { getBrainConfig } from "./brain-config.js";
import type { BrainConfig } from "./brain-config.js";
import type { BrainState } from "./memory/types.js";
import { isOwnerInMeeting } from "./integrations/calendar.js";
import { loadState, patchState } from "./brain-state.js";
import { isQuietHour, quietEndDeliverAt, ownerLocalClock } from "./brain-quiet-hours.js";

export { isQuietHour } from "./brain-quiet-hours.js";

const log = createLogger("brain-delivery");

const SEND_TIMEOUT_MS = 30_000;
/** A direct reply suppressed by a meeting is retried on the scheduled channel after this long. */
const MEETING_REROUTE_DELAY_MS = 30 * 60 * 1000;

// sendMessage is the whatsapp.ts wrapper, which records every successful send
// in delivery-log.json under the given source. Callers must pass the real
// source so the log stays accurate (dedup keys on source === "chat").
type SendFn = (jid: string, text: string, source?: string) => Promise<void>;

function sendWithTimeout(
  sendMessage: SendFn,
  jid: string,
  text: string,
  source: string,
): Promise<void> {
  return Promise.race([
    sendMessage(jid, text, source),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
    ),
  ]);
}

/** Record a delivered message in state without touching any other field. */
function recordDeliveredMessage(now: number, countsTowardDailyLimit: boolean): BrainState {
  return patchState(s => ({
    lastMessageTime: Math.max(s.lastMessageTime, now),
    messagesToday: countsTowardDailyLimit ? s.messagesToday + 1 : s.messagesToday,
  }));
}

// ── Fast Scheduled Message Polling ──
// Lightweight poller that runs every 10s independently of brain ticks.
// Only checks getDueMessages() and delivers them — no full tick overhead.

let schedulerPollPromise: Promise<void> | null = null;
let schedulerPollStartTime: number | null = null;
const SCHEDULER_POLL_TIMEOUT_MS = 60_000; // 60s timeout for stuck polls

/**
 * The `_loadState` / `_saveState` / `_brainDir` parameters are kept for
 * call-site compatibility only; delivery bookkeeping goes through patchState.
 */
export async function pollScheduledMessages(
  sendMessage: SendFn,
  ownerJid: string,
  _loadState?: () => BrainState,
  _saveState?: (s: BrainState) => void,
  _brainDir?: string,
): Promise<void> {
  // Guard against overlapping polls using promise reference
  if (schedulerPollPromise) {
    // Timeout-based auto-recovery for stuck polls
    if (
      schedulerPollStartTime !== null &&
      Date.now() - schedulerPollStartTime > SCHEDULER_POLL_TIMEOUT_MS
    ) {
      log(`Scheduler poll stuck for >${SCHEDULER_POLL_TIMEOUT_MS / 1000}s — auto-clearing guard to resume delivery`);
      schedulerPollPromise = null;
      schedulerPollStartTime = null;
    } else {
      return; // previous poll still running
    }
  }

  schedulerPollStartTime = Date.now();
  schedulerPollPromise = deliverScheduledMessages(sendMessage, ownerJid);
  try {
    await schedulerPollPromise;
  } finally {
    schedulerPollPromise = null;
    schedulerPollStartTime = null;
  }
}

// ── Pending Scheduled Messages ──

/** Pre-send gate for one scheduled message: verifier + brain/chat dedup. */
function scheduledMessageBlockReason(
  msg: { id: string; source: string; message: string },
  jid: string,
  recentChatJids: Set<string>,
): string | null {
  const verifyResult = verify({
    type: "send_scheduled",
    source: msg.source,
    targetJid: jid,
    messageText: msg.message,
    metadata: { scheduleId: msg.id },
  });
  if (verifyResult.verdict === "blocked") {
    return `Verifier blocked scheduled message ${msg.id}: ${verifyResult.reasons.join("; ")}`;
  }
  if (msg.source === "brain" && recentChatJids.has(jid)) {
    return `Dedup: skipping brain-sourced message ${msg.id} to ${jid} — chat-sourced message already delivered in last ${DEDUP_WINDOW_MS / 60000}m`;
  }
  return null;
}

async function deliverScheduledMessages(sendMessage: SendFn, ownerJid: string): Promise<void> {
  // Check WhatsApp connection before attempting any deliveries.
  if (!isWhatsAppConnected()) {
    const dueCount = getScheduledMessages().filter(m => m.deliverAt <= Date.now()).length;
    if (dueCount > 0) {
      log(`Skipping ${dueCount} scheduled message(s): WhatsApp not connected (will retry next tick)`);
    }
    return;
  }

  const dueMessages = getDueMessages();
  const deliveredIds: string[] = [];
  const failedIds: string[] = [];

  // Build set of JIDs that have recent chat-sourced deliveries (for dedup)
  const recentChatJids = new Set(
    getRecentDeliveries(DEDUP_WINDOW_MS).filter(d => d.source === "chat").map(d => d.jid),
  );

  for (const msg of dueMessages) {
    const jid = msg.targetJid || ownerJid;
    try {
      const blockReason = scheduledMessageBlockReason(msg, jid, recentChatJids);
      if (blockReason) {
        log(blockReason);
        logDelivery(jid, msg.source, msg.message, "suppressed");
        deliveredIds.push(msg.id);
        continue;
      }
      await sendWithTimeout(sendMessage, jid, msg.message, msg.source);
      recordDeliveredMessage(Date.now(), true);
      deliveredIds.push(msg.id);
      log(`Delivered scheduled message ${msg.id} to ${jid} (${msg.message.length} chars, source: ${msg.source})`);
    } catch (err) {
      log(`Failed to deliver scheduled message ${msg.id}: ${err}`);
      failedIds.push(msg.id);
    }
  }

  // Remove successfully delivered (and blocked) messages from schedule
  markDelivered(deliveredIds);

  // Increment retry count for failed messages; drops those exceeding max retries
  const droppedIds = markFailed(failedIds);
  for (const id of droppedIds) {
    log(`Permanently dropped scheduled message ${id} after max retries`);
  }
}

// ── Message Sending with Limits ──

/** Outcome of a trySendMessage attempt, so callers can record real delivery status. */
export interface DeliveryResult {
  /** "queued": handed to the scheduled channel (quiet-hours/meeting reroute of a direct reply). */
  status: "sent" | "queued" | "suppressed" | "failed";
  detail?: string;
}

export interface SendGateInput {
  bypass: boolean;
  isDirectReply: boolean;
  isQuiet: boolean;
  inMeeting: boolean;
  messageIntervalOk: boolean;
  underDailyLimit: boolean;
}

export type SendGateVerdict =
  | { action: "send" }
  | { action: "reroute"; reason: "quiet hours" | "owner in meeting" }
  | { action: "suppress"; reason: string };

/**
 * Pure gate decision. Direct replies (answers to an owner-initiated question)
 * skip the interval/daily throttle; when quiet hours or a meeting would
 * suppress one, it is rerouted instead of dropped — an unanswered direct
 * question damages trust more than a late answer.
 */
export function evaluateSendGate(input: SendGateInput): SendGateVerdict {
  const { bypass, isDirectReply, isQuiet, inMeeting, messageIntervalOk, underDailyLimit } = input;
  if (!bypass && isQuiet) {
    return isDirectReply ? { action: "reroute", reason: "quiet hours" } : { action: "suppress", reason: "quiet hours" };
  }
  if (inMeeting) {
    return isDirectReply ? { action: "reroute", reason: "owner in meeting" } : { action: "suppress", reason: "owner in meeting" };
  }
  if (!bypass && !isDirectReply && !messageIntervalOk) return { action: "suppress", reason: "too soon" };
  if (!bypass && !isDirectReply && !underDailyLimit) return { action: "suppress", reason: "daily limit reached" };
  return { action: "send" };
}

function rerouteDeliverAt(reason: "quiet hours" | "owner in meeting", now: number, cfg: BrainConfig): number {
  if (reason === "owner in meeting") return now + MEETING_REROUTE_DELAY_MS;
  return quietEndDeliverAt(now, ownerLocalClock(cfg.ownerTimezone, now), cfg.quietStart, cfg.quietEnd);
}

function rerouteDirectReply(
  recipientJid: string,
  message: string,
  reason: "quiet hours" | "owner in meeting",
  now: number,
  cfg: BrainConfig,
): DeliveryResult {
  try {
    const deliverAt = rerouteDeliverAt(reason, now, cfg);
    const schedId = scheduleMessage(recipientJid, message, deliverAt, "brain");
    log(`Direct reply deferred (${reason}) — rerouted via scheduled channel ${schedId}, delivery at ${new Date(deliverAt).toISOString()}`);
    return { status: "queued", detail: `${reason} — direct reply rerouted to scheduled channel (${schedId}), delivery at ${new Date(deliverAt).toISOString()}` };
  } catch (err) {
    log(`Failed to reroute direct reply (${reason}): ${err}`);
    return { status: "failed", detail: `${reason} — reroute failed: ${err}` };
  }
}

/**
 * Send a brain-originated message subject to the verifier, quiet hours,
 * meetings and the proactive throttle. Throttle inputs are read from disk at
 * call time (not from a tick-start snapshot) so sends by the scheduler poller
 * during a long tick are accounted for; the counters are patched on success.
 */
export async function trySendMessage(
  sendMessage: SendFn,
  ownerJid: string,
  message: string,
  options?: { bypassLimits?: boolean; targetJid?: string | null; isDirectReply?: boolean },
): Promise<DeliveryResult> {
  const cfg = getBrainConfig();
  const now = Date.now();
  const state = loadState();
  const bypass = options?.bypassLimits === true;
  // A verified reply to an owner-initiated question is not a proactive send:
  // it skips the interval/daily throttle and doesn't consume the daily budget.
  // Quiet hours and the verifier gate still apply.
  const isDirectReply = options?.isDirectReply === true;
  const recipientJid = options?.targetJid || ownerJid;

  // Action verifier gate
  const verifyResult = verify({
    type: "send_message",
    source: bypass ? "digest" : "think",
    targetJid: recipientJid,
    messageText: message,
  });
  if (verifyResult.verdict === "blocked") {
    log(`Verifier blocked proactive message: ${verifyResult.reasons.join("; ")}`);
    return { status: "suppressed", detail: `verifier blocked: ${verifyResult.reasons.join("; ")}` };
  }

  const verdict = evaluateSendGate({
    bypass,
    isDirectReply,
    isQuiet: isQuietHour(ownerLocalClock(cfg.ownerTimezone, now).hour, cfg.quietStart, cfg.quietEnd),
    inMeeting: !bypass && isOwnerInMeeting(),
    messageIntervalOk: (now - state.lastMessageTime) >= cfg.minMessageInterval,
    underDailyLimit: state.messagesToday < cfg.maxMessagesPerDay,
  });

  if (verdict.action === "reroute") {
    return rerouteDirectReply(recipientJid, message, verdict.reason, now, cfg);
  }
  if (verdict.action === "suppress") {
    const detail = verdict.reason === "too soon"
      ? `too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last message)`
      : verdict.reason === "daily limit reached"
        ? `daily limit reached (${state.messagesToday}/${cfg.maxMessagesPerDay})`
        : verdict.reason;
    log(`Suppressed message: ${detail}`);
    return { status: "suppressed", detail };
  }

  try {
    if (bypass) log("Briefing message — bypassing rate limits");
    if (isDirectReply) log("Direct reply — exempt from interval/daily throttle");
    await sendMessage(recipientJid, message, bypass ? "digest" : "think");
    const next = recordDeliveredMessage(now, !isDirectReply);
    log(`Sent proactive message to ${recipientJid} (${message.length} chars, #${next.messagesToday} today)`);
    return { status: "sent" };
  } catch (err) {
    log(`Failed to send proactive message: ${err}`);
    return { status: "failed", detail: String(err) };
  }
}
