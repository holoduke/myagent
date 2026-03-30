/**
 * Scheduled message delivery and proactive message sending.
 * Extracted from brain.ts for maintainability.
 */

import { readFileSync, existsSync, unlinkSync } from "fs";
import { createLogger } from "./logger.js";
import { getDueMessages, getScheduledMessages, markDelivered, markFailed, logDelivery, getRecentDeliveries, DEDUP_WINDOW_MS } from "./scheduler.js";
import { isWhatsAppConnected } from "./integrations/whatsapp.js";
import { verify } from "./action-verifier.js";
import { getBrainConfig, getOwnerLocalTime } from "./brain-config.js";
import type { BrainState } from "./memory/types.js";

const log = createLogger("brain-delivery");

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
      const SEND_TIMEOUT_MS = 30_000;
      await Promise.race([
        sendMessage(jid, msg.message),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
        ),
      ]);
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

  // Legacy: also check single pending-message.json for backward compatibility
  const pendingPath = `${brainDir}/pending-message.json`;
  if (!existsSync(pendingPath)) {
    if (anyDelivered) saveState(state);
    return;
  }
  try {
    const raw = readFileSync(pendingPath, "utf-8");
    const pending = JSON.parse(raw) as { sendAt: number; message: string };
    if (Date.now() >= pending.sendAt) {
      const verifyResult = verify({
        type: "send_scheduled",
        source: "legacy-pending",
        targetJid: ownerJid,
        messageText: pending.message,
        metadata: { legacy: true },
      });
      if (verifyResult.verdict === "blocked") {
        log(`Verifier blocked legacy pending message: ${verifyResult.reasons.join("; ")}`);
        unlinkSync(pendingPath);
        if (anyDelivered) saveState(state);
        return;
      }

      const SEND_TIMEOUT_MS = 30_000;
      await Promise.race([
        sendMessage(ownerJid, pending.message),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`sendMessage timed out after ${SEND_TIMEOUT_MS / 1000}s`)), SEND_TIMEOUT_MS),
        ),
      ]);
      state.lastMessageTime = Date.now();
      state.messagesToday++;
      anyDelivered = true;
      unlinkSync(pendingPath);
      log(`Sent legacy pending message (${pending.message.length} chars)`);
    }
  } catch (err) {
    log(`Error processing legacy pending message: ${err}`);
    try { unlinkSync(pendingPath); } catch (cleanupErr) { log(`Failed to clean up legacy pending message file: ${cleanupErr}`); }
  }

  if (anyDelivered) saveState(state);
}

// ── Message Sending with Limits ──

export async function trySendMessage(
  state: BrainState,
  sendMessage: (jid: string, text: string) => Promise<void>,
  ownerJid: string,
  message: string,
  options?: { bypassLimits?: boolean; targetJid?: string | null },
): Promise<void> {
  const cfg = getBrainConfig();
  const now = Date.now();
  const { hour: currentHour } = getOwnerLocalTime(cfg.ownerTimezone);
  const isQuiet = cfg.quietStart !== cfg.quietEnd && (currentHour >= cfg.quietStart || currentHour < cfg.quietEnd);
  const messageIntervalOk = (now - state.lastMessageTime) >= cfg.minMessageInterval;
  const underDailyLimit = state.messagesToday < cfg.maxMessagesPerDay;
  const bypass = options?.bypassLimits === true;
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
    return;
  }

  if (!bypass && isQuiet) {
    log("Suppressed message: quiet hours");
  } else if (!bypass && !messageIntervalOk) {
    log(`Suppressed message: too soon (${Math.round((now - state.lastMessageTime) / 60000)}m since last)`);
  } else if (!bypass && !underDailyLimit) {
    log(`Suppressed message: daily limit reached (${state.messagesToday}/${cfg.maxMessagesPerDay})`);
  } else {
    try {
      if (bypass) log("Briefing message — bypassing rate limits");
      await sendMessage(recipientJid, message);
      state.lastMessageTime = now;
      state.messagesToday++;
      logDelivery(recipientJid, bypass ? "digest" : "think", message);
      log(`Sent proactive message to ${recipientJid} (${message.length} chars, #${state.messagesToday} today)`);
    } catch (err) {
      log(`Failed to send proactive message: ${err}`);
    }
  }
}
