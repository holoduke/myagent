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
import type { proto } from "@whiskeysockets/baileys";

const log = createLogger("owner-handler");

const SEND_INTERVAL_MS = 15_000;
const MIN_CHUNK_LENGTH = 50;

export interface OwnerHandlerDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendReaction: (jid: string, key: proto.IMessageKey, emoji: string) => Promise<void>;
  sendTypingIndicator: (jid: string) => Promise<void>;
  stopTypingIndicator: (jid: string) => Promise<void>;
}

export function createOwnerHandler(deps: OwnerHandlerDeps) {
  const { sendMessage, sendReaction, sendTypingIndicator, stopTypingIndicator } = deps;

  return async function handleOwnerMessage(
    jid: string,
    text: string,
    message: proto.IWebMessageInfo,
  ): Promise<void> {
    log(`Received from ${jid}: "${text}"`);

    if (handleCaptchaReply(text)) {
      log("Message consumed as captcha answer");
      try { await sendReaction(jid, message.key, "\u2705"); } catch { /* intentionally ignored */ }
      return;
    }

    try {
      await sendReaction(jid, message.key, "\u23f3");
    } catch (err) {
      log(`Failed to send reaction: ${err}`);
    }

    try {
      const command = text.trim().toLowerCase();

      if (command === "/reset") {
        resetSession();
        clearHistory();
        await sendMessage(jid, "Session reset. Starting fresh conversation.");
        await sendReaction(jid, message.key, "\u2705");
        return;
      }

      if (command === "/usage") {
        await sendMessage(jid, getUsageStats());
        await sendReaction(jid, message.key, "\u2705");
        return;
      }

      addMessage({ role: "user", content: text, timestamp: Date.now(), source: "whatsapp" });

      const provider = getDefaultProvider();
      log(`Calling ${provider.name} with: "${text.slice(0, 80)}"`);

      const fullResponse = provider.supportsStreaming
        ? await handleStreaming(jid, text, provider, sendMessage, sendTypingIndicator, stopTypingIndicator)
        : await handleNonStreaming(jid, text, provider, sendMessage);

      log(`${provider.name} returned, response ${fullResponse.length} chars, first 200: ${fullResponse.slice(0, 200)}`);
      addMessage({ role: "assistant", content: fullResponse, timestamp: Date.now(), source: "whatsapp" });
      await sendReaction(jid, message.key, "\u2705");
      log(`Done - responded to ${jid}`);
    } catch (err) {
      log(`ERROR: ${err}`);
      const errorMsg = err instanceof Error ? err.message : "Unknown error occurred";
      try {
        await sendMessage(jid, `Error: ${errorMsg}`);
        await sendReaction(jid, message.key, "\u274c");
      } catch (sendErr) {
        log(`Failed to send error message: ${sendErr}`);
      }
    }
  };
}

// ── Streaming ──

async function handleStreaming(
  jid: string,
  text: string,
  provider: ReturnType<typeof getDefaultProvider>,
  sendMessage: (jid: string, text: string) => Promise<void>,
  sendTyping: (jid: string) => Promise<void>,
  stopTyping: (jid: string) => Promise<void>,
): Promise<string> {
  let fullResponse = "";
  let chunkBuffer = "";
  let lastSendTime = Date.now();

  await sendTyping(jid);
  const typingInterval = setInterval(() => {
    sendTyping(jid).catch(() => {});
  }, 10_000);

  try {
    await provider.askStreaming(text, (delta) => {
      fullResponse += delta;
      chunkBuffer += delta;

      const now = Date.now();
      if (now - lastSendTime >= SEND_INTERVAL_MS && chunkBuffer.length >= MIN_CHUNK_LENGTH) {
        const splitIdx = findSentenceBoundary(chunkBuffer);
        if (splitIdx > 0) {
          const toSend = chunkBuffer.slice(0, splitIdx).trim();
          chunkBuffer = chunkBuffer.slice(splitIdx);
          lastSendTime = now;

          if (toSend.length > 0) {
            for (const c of splitMessage(toSend)) {
              sendMessage(jid, c).catch((err) => {
                log(`Warning: failed to send intermediate chunk: ${err}`);
              });
            }
            log(`Sent intermediate chunk (${toSend.length} chars) to ${jid}`);
          }
        }
      }
    }, {});
  } finally {
    clearInterval(typingInterval);
    await stopTyping(jid);
  }

  const remaining = chunkBuffer.trim();
  if (remaining.length > 0) {
    for (const c of splitMessage(remaining)) {
      log(`Sending final chunk (${c.length} chars) to ${jid}`);
      await sendMessage(jid, c);
    }
  }

  return fullResponse;
}

// ── Non-streaming ──

async function handleNonStreaming(
  jid: string,
  text: string,
  provider: ReturnType<typeof getDefaultProvider>,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<string> {
  const result = await provider.ask(text, {});
  for (const chunk of result.messages) {
    log(`Sending chunk (${chunk.length} chars) to ${jid}`);
    await sendMessage(jid, chunk);
  }
  return result.messages.join("\n");
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
