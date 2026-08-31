/**
 * Scheduled message delivery and proactive message sending.
 * Extracted from brain.ts for maintainability.
 */

import { createLogger } from "./logger.js";
import { getDueMessages, getScheduledMessages, markDelivered, markFailed, logDelivery, getRecentDeliveries, DEDUP_WINDOW_MS } from "./scheduler.js";
import { isWhatsAppConnected } from "./integrations/whatsapp.js";
import { verify } from "./action-verifier.js";
import { getBrainConfig, getOwnerLocalTime } from "./brain-config.js";
import type { BrainState } from "./memory/types.js";
import { isOwnerInMeeting } from "./integrations/calendar.js";

const log = createLogger("brain-delivery");

const SEND_TIMEOUT_MS = 30_000;

function sendWithTimeout(
  sendMessage: (jid: string, text: string) => Promise<void>,
  jid: string,
  text: string,
): Promise<void> {
  return Promise.race([
    sendMessage(jid, text),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
    ),
  ]);
}

// ── Fast Scheduled Message Polling ──
// Lightweight poller that runs every 10s independently of brain ticks.
// Only checks getDueMessages() and delivers them — no full tick overhead.

let schedulerPollPromise: Promise<void> | null = null;
let schedulerPollStartTime: number | null = null;
const SCHEDULER_POLL_TIMEOUT_MS = 60_000; // 60s timeout for stuck polls

export async function pollScheduledMessages(
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  loadState: () => BrainState,
  saveState: (s: BrainState) => void,
  brainDir: string,
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

  const doPoll = async (): Promise<void> => {
    const state = loadState();
    await deliverScheduledMessages(state, sendMessage, ownerJid, saveState, brainDir);
  };

  schedulerPollPromise = doPoll();
  try {
    await schedulerPollPromise;
  } finally {
    schedulerPollPromise = null;
    schedulerPollStartTime = null;
  }
}

// ── Pending Scheduled Messages ──

async function deliverScheduledMessages(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  saveState: (s: BrainState) => void,
  brainDir: string,
): Promise<void> {
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
  let anyDelivered = false;

  // Build set of JIDs that have recent chat-sourced deliveries (for dedup)
  const recentDeliveries = getRecentDeliveries(DEDUP_WINDOW_MS);
  const recentChatJids = new Set(
    recentDeliveries.filter(d => d.source === "chat").map(d => d.jid),
  );

  for (const msg of dueMessages) {
    try {
      const jid = msg.targetJid || ownerJid;

      // Action verifier gate
      const verifyResult = verify({
        type: "send_scheduled",
        source: msg.source,
        targetJid: jid,
        messageText: msg.message,
        metadata: { scheduleId: msg.id },
      });
      if (verifyResult.verdict === "blocked") {
        log(`Verifier blocked scheduled message ${msg.id}: ${verifyResult.reasons.join("; ")}`);
        deliveredIds.push(msg.id);
        continue;
      }

      // Dedup: skip brain-sourced messages to JIDs that already received a chat-sourced message recently
      if (msg.source === "brain" && recentChatJids.has(jid)) {
        log(`Dedup: skipping brain-sourced message ${msg.id} to ${jid} — chat-sourced message already delivered in last ${DEDUP_WINDOW_MS / 60000}m`);
        deliveredIds.push(msg.id);
        continue;
      }
      await sendWithTimeout(sendMessage, jid, msg.message);
      state.lastMessageTime = Date.now();
      state.messagesToday++;
      anyDelivered = true;
      deliveredIds.push(msg.id);
      logDelivery(jid, msg.source, msg.message);
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

  if (anyDelivered) saveState(state);
}

// ── Message Sending with Limits ──

/** Outcome of a trySendMessage attempt, so callers can record real delivery status. */
export interface DeliveryResult {
  status: "sent" | "suppressed" | "failed";
  detail?: string;
}

/** Whether an owner-local hour falls inside the configured quiet window. */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  return quietStart > quietEnd
    ? (hour >= quietStart || hour < quietEnd)   // overnight range (e.g. 23→7)
    : (hour >= quietStart && hour < quietEnd);  // same-day range (e.g. 8→22)
}

export async function trySendMessage(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  message: string,
  options?: { bypassLimits?: boolean; targetJid?: string | null; isDirectReply?: boolean },
): Promise<DeliveryResult> {
  const cfg = getBrainConfig();
  const now = Date.now();
  const { hour: currentHour } = getOwnerLocalTime(cfg.ownerTimezone);
  const isQuiet = isQuietHour(currentHour, cfg.quietStart, cfg.quietEnd);
  const messageIntervalOk = (now - state.lastMessageTime) >= cfg.minMessageInterval;
  const underDailyLimit = state.messagesToday < cfg.maxMessagesPerDay;
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

  // Check if owner is in a meeting — suppress non-bypass proactive messages
  const inMeeting = !bypass && isOwnerInMeeting();

  if (!bypass && isQuiet) {
    if (isDirectReply) {
      log("Suppressed message: quiet hours (was a direct reply — candidate for scheduled-channel reroute)");
      return { status: "suppressed", detail: "quiet hours (direct reply — candidate for scheduled-channel reroute)" };
    }
    log("Suppressed message: quiet hours");
    return { status: "suppressed", detail: "quiet hours" };
  } else if (inMeeting) {
    if (isDirectReply) {
      log("Suppressed message: owner is in a meeting (was a direct reply — candidate for scheduled-channel reroute)");
      return { status: "suppressed", detail: "owner in meeting (direct reply — candidate for scheduled-channel reroute)" };
    }
    log("Suppressed message: owner is in a meeting");
    return { status: "suppressed", detail: "owner in meeting" };
  } else if (!bypass && !isDirectReply && !messageIntervalOk) {
    log(`Suppressed message: too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last)`);
    return { status: "suppressed", detail: `too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last message)` };
  } else if (!bypass && !isDirectReply && !underDailyLimit) {
    log(`Suppressed message: daily limit reached (${state.messagesToday}/${cfg.maxMessagesPerDay})`);
    return { status: "suppressed", detail: `daily limit reached (${state.messagesToday}/${cfg.maxMessagesPerDay})` };
  } else {
    try {
      if (bypass) log("Briefing message — bypassing rate limits");
      if (isDirectReply) log("Direct reply — exempt from interval/daily throttle");
      await sendMessage(recipientJid, message);
      state.lastMessageTime = now;
      if (!isDirectReply) state.messagesToday++;
      logDelivery(recipientJid, bypass ? "digest" : "think", message);
      log(`Sent proactive message to ${recipientJid} (${message.length} chars, #${state.messagesToday} today)`);
      return { status: "sent" };
    } catch (err) {
      log(`Failed to send proactive message: ${err}`);
      return { status: "failed", detail: String(err) };
    }
  }
}
