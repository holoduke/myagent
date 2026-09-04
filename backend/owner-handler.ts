/**
 * Owner message handler — processes direct WhatsApp messages from the owner.
 *
 * Handles commands (/reset, /usage), streaming responses with intermediate
 * chunk delivery, typing indicators, and error reporting via reactions.
 *
 * Extracted from index.ts for testability and readability.
 */

import { createLogger } from "./logger.js";
import { resetSession } from "./claude.js";
import { getDefaultProvider } from "./providers/index.js";
import { splitMessage } from "./providers/util.js";
import { addMessage, clearHistory, getUsageStats } from "./history.js";
import { handleCaptchaReply } from "./captcha-verify.js";
import { createSendChain } from "./send-chain.js";
import type { SendResult } from "./integrations/whatsapp.js";
import type { proto } from "@whiskeysockets/baileys";

const log = createLogger("owner-handler");

const SEND_INTERVAL_MS = 15_000;
const MIN_CHUNK_LENGTH = 50;

/** `void` is accepted so plain test doubles still satisfy the interface. */
export type OwnerSendFn = (jid: string, text: string) => Promise<SendResult | void>;

export interface OwnerHandlerDeps {
  sendMessage: OwnerSendFn;
  sendReaction: (jid: string, key: proto.IMessageKey | null | undefined, emoji: string) => Promise<void>;
  sendTypingIndicator: (jid: string) => Promise<void>;
  stopTypingIndicator: (jid: string) => Promise<void>;
}

export interface OwnerReplyOutcome {
  fullResponse: string;
  /** False when at least one chunk was only buffered (socket down) or lost. */
  delivered: boolean;
}

type Provider = ReturnType<typeof getDefaultProvider>;

/**
 * Returns a handler that resolves `true` when the reply was confirmed sent
 * (or the message needed no reply) and `false` when delivery is unconfirmed
 * — the runtime uses this to decide whether the inbox entry is done.
 */
export function createOwnerHandler(deps: OwnerHandlerDeps) {
  const { sendMessage, sendReaction, sendTypingIndicator, stopTypingIndicator } = deps;

  return async function handleOwnerMessage(
    jid: string,
    text: string,
    message: proto.IWebMessageInfo,
  ): Promise<boolean> {
    log(`Received from ${jid}: "${text}"`);

    if (handleCaptchaReply(text)) {
      log("Message consumed as captcha answer");
      try { await sendReaction(jid, message.key, "✅"); } catch { /* intentionally ignored */ }
      return true;
    }

    try {
      await sendReaction(jid, message.key, "⏳");
    } catch (err) {
      log(`Failed to send reaction: ${err}`);
    }

    try {
      if (await handleCommand(jid, text, message, sendMessage, sendReaction)) return true;

      addMessage({ role: "user", content: text, timestamp: Date.now(), source: "whatsapp" });

      const provider = getDefaultProvider();
      log(`Calling ${provider.name} with: "${text.slice(0, 80)}"`);

      const outcome = provider.supportsStreaming
        ? await handleStreaming(jid, text, provider, sendMessage, sendTypingIndicator, stopTypingIndicator)
        : await handleNonStreaming(jid, text, provider, sendMessage);

      log(`${provider.name} returned, response ${outcome.fullResponse.length} chars, first 200: ${outcome.fullResponse.slice(0, 200)}`);
      addMessage({ role: "assistant", content: outcome.fullResponse, timestamp: Date.now(), source: "whatsapp" });
      if (outcome.delivered) {
        await sendReaction(jid, message.key, "✅");
        log(`Done - responded to ${jid}`);
        return true;
      }
      log.warn(`Reply to ${jid} was NOT confirmed delivered (buffered or failed chunks) — skipping success reaction`);
      return false;
    } catch (err) {
      log(`ERROR: ${err}`);
      const errorMsg = err instanceof Error ? err.message : "Unknown error occurred";
      try {
        const sent = isDelivered(await sendMessage(jid, `Error: ${errorMsg}`));
        await sendReaction(jid, message.key, "❌");
        return sent;
      } catch (sendErr) {
        log(`Failed to send error message: ${sendErr}`);
        return false;
      }
    }
  };
}

// ── Commands ──

async function handleCommand(
  jid: string,
  text: string,
  message: proto.IWebMessageInfo,
  sendMessage: OwnerSendFn,
  sendReaction: OwnerHandlerDeps["sendReaction"],
): Promise<boolean> {
  const command = text.trim().toLowerCase();

  if (command === "/reset") {
    resetSession();
    clearHistory();
    await sendMessage(jid, "Session reset. Starting fresh conversation.");
    await sendReaction(jid, message.key, "✅");
    return true;
  }

  if (command === "/usage") {
    await sendMessage(jid, getUsageStats());
    await sendReaction(jid, message.key, "✅");
    return true;
  }

  return false;
}

// ── Delivery tracking ──

function isDelivered(result: SendResult | void): boolean {
  return !result || result.status === "sent";
}

// ── Streaming ──

async function handleStreaming(
  jid: string,
  text: string,
  provider: Provider,
  sendMessage: OwnerSendFn,
  sendTyping: (jid: string) => Promise<void>,
  stopTyping: (jid: string) => Promise<void>,
): Promise<OwnerReplyOutcome> {
  let fullResponse = "";
  let chunkBuffer = "";
  let lastSendTime = Date.now();
  let delivered = true;

  // Intermediate chunks go through a sequential chain so they arrive in
  // order; a chunk that fails twice is folded into the final message.
  const chain = createSendChain(
    async (c) => { if (!isDelivered(await sendMessage(jid, c))) delivered = false; },
    { onError: (c, err, attempt) => log(`Warning: intermediate chunk send failed (attempt ${attempt + 1}, ${c.length} chars): ${err}`) },
  );

  await sendTyping(jid);
  const typingInterval = setInterval(() => {
    sendTyping(jid).catch(() => {});
  }, 10_000);

  try {
    await provider.askStreaming(text, (delta) => {
      fullResponse += delta;
      chunkBuffer += delta;

      const now = Date.now();
      if (now - lastSendTime < SEND_INTERVAL_MS || chunkBuffer.length < MIN_CHUNK_LENGTH) return;
      const splitIdx = findSentenceBoundary(chunkBuffer);
      if (splitIdx <= 0) return;

      const toSend = chunkBuffer.slice(0, splitIdx).trim();
      chunkBuffer = chunkBuffer.slice(splitIdx);
      lastSendTime = now;
      if (toSend.length === 0) return;

      for (const c of splitMessage(toSend)) void chain.enqueue(c);
      log(`Queued intermediate chunk (${toSend.length} chars) to ${jid}`);
    }, {});
  } finally {
    clearInterval(typingInterval);
    await stopTyping(jid);
  }

  const { failed } = await chain.settle();
  if (failed.length > 0) log.warn(`${failed.length} intermediate chunk(s) failed twice — appending to final message`);

  const finalText = [...failed, chunkBuffer].map((s) => s.trim()).filter((s) => s.length > 0).join("\n\n");
  const finalChunks = finalText.length > 0 ? splitMessage(finalText) : [];
  for (const c of finalChunks) {
    log(`Sending final chunk (${c.length} chars) to ${jid}`);
    if (!isDelivered(await sendMessage(jid, c))) delivered = false;
  }

  return { fullResponse, delivered };
}

// ── Non-streaming ──

async function handleNonStreaming(
  jid: string,
  text: string,
  provider: Provider,
  sendMessage: OwnerSendFn,
): Promise<OwnerReplyOutcome> {
  const result = await provider.ask(text, {});
  let delivered = true;
  for (const chunk of result.messages) {
    log(`Sending chunk (${chunk.length} chars) to ${jid}`);
    if (!isDelivered(await sendMessage(jid, chunk))) delivered = false;
  }
  return { fullResponse: result.messages.join("\n"), delivered };
}

// ── Helpers ──

function findSentenceBoundary(text: string): number {
  for (let i = text.length - 1; i >= MIN_CHUNK_LENGTH / 2; i--) {
    if (text[i] === "\n") return i + 1;
    if (text[i] === "." && (i === text.length - 1 || text[i + 1] === " " || text[i + 1] === "\n")) {
      return i + 1;
    }
  }
  return -1;
}
