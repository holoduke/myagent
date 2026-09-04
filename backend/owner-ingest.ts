/**
 * Owner ingest — the durable path from "owner message arrived" to "handler
 * ran and the reply went out":
 *
 *   journal (owner-inbox) ─► queue.offer ─► handler ─► journal done
 *
 * Nothing here throws into the WhatsApp upsert loop: a full/closed queue is
 * logged and the journal entry stays pending so the next activation replays
 * it. Pure enough to unit-test with a fake handler and a temp inbox.
 */

import { createLogger } from "./logger.js";
import type { MessageQueue } from "./queue.js";
import type { OwnerInbox, InboxReceived } from "./owner-inbox.js";
import type { proto } from "@whiskeysockets/baileys";

const log = createLogger("owner-ingest");

/** Resolves true when the reply was confirmed delivered. */
export type OwnerHandler = (jid: string, text: string, message: proto.IWebMessageInfo) => Promise<boolean>;

export interface OwnerIngest {
  /** Journal + enqueue. Returns whether the queue accepted the message. */
  enqueue(jid: string, text: string, message: proto.IWebMessageInfo): boolean;
  /** Compact the inbox and re-enqueue every pending entry. Returns the count. */
  replay(): number;
}

export function syntheticMessage(entry: InboxReceived): proto.IWebMessageInfo {
  return { key: { remoteJid: entry.jid, fromMe: false, id: entry.id } };
}

function messageId(message: proto.IWebMessageInfo): string {
  return message.key?.id ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createOwnerIngest(queue: MessageQueue, inbox: OwnerInbox, handler: OwnerHandler): OwnerIngest {
  const dispatch = (id: string, jid: string, text: string, message: proto.IWebMessageInfo): boolean => {
    const offered = queue.offer(() => handler(jid, text, message));
    if (!offered.accepted) {
      log.warn(`Owner message ${id} NOT queued (queue ${offered.reason}) — left pending in inbox for replay`);
      return false;
    }
    offered.result
      .then((delivered) => {
        if (delivered) inbox.recordDone(id);
        else log.warn(`Owner message ${id} handled but reply not confirmed — left pending in inbox`);
      })
      .catch((err) => log.error(`Owner message ${id} failed: ${err}`));
    return true;
  };

  return {
    enqueue: (jid, text, message) => {
      const id = messageId(message);
      inbox.recordReceived({ id, jid, text, receivedAt: Date.now() });
      return dispatch(id, jid, text, message);
    },
    replay: () => {
      const pending = inbox.compact();
      if (pending.length === 0) return 0;
      log.info(`Replaying ${pending.length} pending owner message(s) from inbox`);
      for (const entry of pending) {
        log.info(`Replay ${entry.id} received ${new Date(entry.receivedAt).toISOString()}: "${entry.text.slice(0, 60)}"`);
        dispatch(entry.id, entry.jid, entry.text, syntheticMessage(entry));
      }
      return pending.length;
    },
  };
}
