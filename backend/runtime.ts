/**
 * Instance runtime — the ACTIVE / PASSIVE state machine behind a rolling deploy.
 *
 *   boot ─► passive ─(lease acquired)─► active ─(SIGTERM)─► draining ─► stopped
 *                ▲                        │
 *                └──(WhatsApp replaced)───┘
 *
 * PASSIVE: HTTP only. ACTIVE: brain loop, integration pollers, HA digest,
 * WhatsApp. Every transition is logged. index.ts owns the HTTP server and
 * signal handlers and calls into this module.
 */

import { createLogger } from "./logger.js";
import { SHUTDOWN_DRAIN_MS } from "./config.js";
import { MessageQueue } from "./queue.js";
import { startBrainLoop, stopBrainLoop } from "./brain.js";
import { startTokenRefreshLoop } from "./auth-refresh.js";
import { recordObservation } from "./observer.js";
import {
  startWhatsApp, stopWhatsApp, sendMessage, sendReaction, sendTypingIndicator, stopTypingIndicator,
  type ObservationEvent,
} from "./integrations/whatsapp.js";
import { startGmailPolling, stopGmailPolling } from "./integrations/gmail.js";
import { startCalendarPolling, stopCalendarPolling } from "./integrations/calendar.js";
import { startHAPolling, stopHAPolling, ensureWebhookToken } from "./integrations/homeassistant.js";
import { startHADigestLoop, stopHADigestLoop } from "./ha-digest.js";
import { startRSSPolling, stopRSSPolling } from "./integrations/rss.js";
import { startPlayStorePolling, stopPlayStorePolling } from "./integrations/playstore-poll.js";
import { startSlackPolling, stopSlackPolling } from "./integrations/slack.js";
import { initReplyAgent } from "./reply-agent.js";
import { initMessageHandlers } from "./message-handlers.js";
import { initBrowser, closeBrowser } from "./integrations/browser.js";
import { createOwnerHandler } from "./owner-handler.js";
import { createOwnerInbox, type OwnerInbox } from "./owner-inbox.js";
import { createOwnerIngest } from "./owner-ingest.js";
import type { InstanceLease } from "./instance-lease.js";

const log = createLogger("runtime");

export type RuntimeMode = "booting" | "passive" | "active" | "draining" | "stopped";

export interface Runtime {
  readonly mode: RuntimeMode;
  readonly queue: MessageQueue;
  /** Record that this instance is waiting for the lease (HTTP only). */
  passive(reason: string): void;
  /** Start everything (brain, pollers, WhatsApp) and replay the owner inbox. */
  activate(reason: string): Promise<void>;
  /** Stop everything and give the lease back; the caller decides to wait again. */
  demote(reason: string): Promise<void>;
  /** SIGTERM path: stop, drain the owner queue, release the lease. */
  shutdown(signal: string): Promise<void>;
}

export interface RuntimeOptions {
  lease: InstanceLease;
  queue?: MessageQueue;
  inbox?: OwnerInbox;
  drainMs?: number;
}

function stopPollers(): void {
  stopGmailPolling();
  stopSlackPolling();
  stopCalendarPolling();
  stopHAPolling();
  stopHADigestLoop();
  stopRSSPolling();
  stopPlayStorePolling();
}

function startPollers(): void {
  startGmailPolling();
  startCalendarPolling();
  ensureWebhookToken();
  startHAPolling();
  startHADigestLoop();
  startRSSPolling();
  startSlackPolling();
  startPlayStorePolling();
}

/** Demotion path: stop everything immediately (no drain — the lease goes to the other side). */
function stopServices(): void {
  stopBrainLoop();
  stopPollers();
  stopWhatsApp();
  void closeBrowser();
}

function toObservation(obs: ObservationEvent): void {
  recordObservation({
    timestamp: Date.now(),
    sender: obs.senderName,
    senderJid: obs.senderJid,
    isGroup: obs.isGroup,
    groupName: obs.groupName,
    isFromMe: obs.isFromMe,
    text: obs.text,
    source: "whatsapp",
    chatJid: obs.chatJid,
    chatName: obs.chatName,
    messageId: obs.messageId,
    mediaType: obs.mediaType,
  });
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const { lease } = opts;
  const queue = opts.queue ?? new MessageQueue();
  const inbox = opts.inbox ?? createOwnerInbox();
  const drainMs = opts.drainMs ?? SHUTDOWN_DRAIN_MS;
  let mode: RuntimeMode = "booting";
  let tokenLoopStarted = false;

  const ownerHandler = createOwnerHandler({
    sendMessage, sendReaction, sendTypingIndicator, stopTypingIndicator,
  });
  const ingest = createOwnerIngest(queue, inbox, ownerHandler);
  // Brain, reply agent and message handlers only need fire-and-forget sends.
  const sendVoid = async (jid: string, text: string, source?: string): Promise<void> => {
    await sendMessage(jid, text, source);
  };

  const transition = (next: RuntimeMode, reason: string): void => {
    log.info(`Mode ${mode} → ${next} (${reason})`);
    mode = next;
  };

  const passive = (reason: string): void => {
    if (mode === "booting") transition("passive", reason);
  };

  const activate = async (reason: string): Promise<void> => {
    if (mode === "active") {
      log.warn(`activate(${reason}) ignored — already active`);
      return;
    }
    transition("active", reason);

    if (!tokenLoopStarted) {
      startTokenRefreshLoop();
      tokenLoopStarted = true;
    }
    startBrainLoop(queue, sendVoid);
    initReplyAgent(sendVoid);
    initMessageHandlers(sendVoid);
    startPollers();
    void initBrowser();

    await startWhatsApp(
      async (jid, text, message) => { ingest.enqueue(jid, text, message); },
      toObservation,
    );
    ingest.replay();
  };

  const demote = async (reason: string): Promise<void> => {
    if (mode !== "active") {
      log.warn(`demote(${reason}) ignored — mode is ${mode}`);
      return;
    }
    transition("passive", reason);
    stopServices();
    lease.release();
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (mode === "draining" || mode === "stopped") return;
    const wasActive = mode === "active";
    transition("draining", signal);

    if (wasActive) {
      stopBrainLoop();
      stopPollers();
      // Release first: the replacement instance activates within a poll
      // interval instead of waiting for the lock to go stale if Docker kills
      // us before the drain finishes. Our WhatsApp socket may get replaced
      // (440) during the drain; undelivered owner replies stay in the inbox
      // and are replayed by the new instance.
      lease.release();
      const drained = await queue.drain(drainMs);
      log.info(drained ? "Owner queue drained" : `Owner queue drain deadline (${drainMs}ms) hit — pending replies stay in inbox`);
      stopWhatsApp();
      await Promise.race([
        closeBrowser().catch((err) => log.warn(`closeBrowser failed: ${err}`)),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    } else {
      lease.release();
    }
    transition("stopped", signal);
  };

  return {
    get mode() { return mode; },
    queue,
    passive,
    activate,
    demote,
    shutdown,
  };
}
