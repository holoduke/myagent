import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { brainDir } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  return { brainDir: mkdtempSync(join(tmpdir(), "reply-agent-")) };
});

vi.mock("../backend/logger.js", () => ({
  createLogger: () => Object.assign((..._args: unknown[]) => {}, { info: () => {}, warn: () => {}, error: () => {} }),
}));

vi.mock("../backend/config.js", () => ({
  BRAIN_DIR: brainDir,
  OWNER_PHONE: "31600000000",
}));

vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ enabled: true, models: { messageEval: "haiku" } }),
}));

const verifyMock = vi.hoisted(() => vi.fn(() => ({ verdict: "allowed" as const, reasons: [] as string[] })));
vi.mock("../backend/action-verifier.js", () => ({ verify: verifyMock }));

const whitelistMock = vi.hoisted(() => ({
  whitelisted: new Set<string>(),
  isWhitelisted: (jid: string) => whitelistMock.whitelisted.has(jid),
  resolveCanonicalJid: (jid: string) => jid.replace(/@lid$/, "@s.whatsapp.net"),
}));
vi.mock("../backend/contact-whitelist.js", () => ({
  isWhitelisted: whitelistMock.isWhitelisted,
  resolveCanonicalJid: whitelistMock.resolveCanonicalJid,
}));

import {
  isOptOut,
  isOptedOut,
  clearOptOut,
  canReply,
  initReplyAgent,
  sendGuardedReply,
  dispatchReply,
  hasRepliedTo,
  resolveReplyDirective,
  addReplyDirective,
  updateReplyDirective,
  getReplyDirectives,
  getReplyLog,
} from "../backend/reply-agent.js";
import type { Observation } from "../backend/observer.js";

function makeObs(overrides: Partial<Observation> = {}): Observation {
  return {
    timestamp: Date.now(),
    sender: "Alice",
    senderJid: "alice@s.whatsapp.net",
    chatJid: "alice@s.whatsapp.net",
    isGroup: false,
    isFromMe: false,
    text: "hoi, kun je me helpen?",
    source: "whatsapp",
    trustLevel: "untrusted",
    ...overrides,
  };
}

afterAll(() => {
  rmSync(brainDir, { recursive: true, force: true });
});

describe("isOptOut", () => {
  it("matches whole-utterance stop words", () => {
    expect(isOptOut("stop")).toBe(true);
    expect(isOptOut("STOP!")).toBe(true);
    expect(isOptOut("niet meer")).toBe(true);
    expect(isOptOut("block")).toBe(true);
  });

  it("matches explicit stop-messaging phrases", () => {
    expect(isOptOut("please stop messaging me")).toBe(true);
    expect(isOptOut("stuur me niet meer")).toBe(true);
    expect(isOptOut("ik wil niet meer reageren hierop")).toBe(true);
  });

  it("matches stop words addressed to ARIA or 'jij'", () => {
    expect(isOptOut("aria, stop hiermee")).toBe(true);
    expect(isOptOut("jij moet niet meer antwoorden")).toBe(true);
  });

  it("ignores stop words used in ordinary conversation", () => {
    expect(isOptOut("de bus stopt niet meer bij ons")).toBe(false);
    expect(isOptOut("ik ga niet meer naar de sportschool")).toBe(false);
    expect(isOptOut("kun je stoppen bij de supermarkt?")).toBe(false);
    expect(isOptOut("we had to block the road for the party")).toBe(false);
    expect(isOptOut("stop de auto even hier")).toBe(false);
  });
});

describe("resolveReplyDirective", () => {
  it("returns the category default for private chats and null for groups", () => {
    updateReplyDirective("rd_others", { enabled: true });
    expect(resolveReplyDirective("bob@s.whatsapp.net", "bob@s.whatsapp.net", false)?.id).toBe("rd_others");
    expect(resolveReplyDirective("bob@s.whatsapp.net", "group@g.us", true)).toBeNull();
  });

  it("uses the whitelisted category for whitelisted senders", () => {
    updateReplyDirective("rd_whitelisted", { enabled: true });
    whitelistMock.whitelisted.add("carol@s.whatsapp.net");
    expect(resolveReplyDirective("carol@s.whatsapp.net", undefined, false)?.id).toBe("rd_whitelisted");
  });

  it("applies an explicit group override inside that group", () => {
    const d = addReplyDirective({ contactJid: "team@g.us", filterPrompt: "f", replyPrompt: "r" });
    expect(resolveReplyDirective("bob@s.whatsapp.net", "team@g.us", true)?.id).toBe(d.id);
    expect(getReplyDirectives().some(x => x.id === d.id)).toBe(true);
  });
});

describe("sendGuardedReply", () => {
  const send = vi.fn(async () => {});

  beforeEach(() => {
    send.mockClear();
    verifyMock.mockClear();
    initReplyAgent(send);
  });

  it("sends once and blocks a second reply to the same message", async () => {
    const obs = makeObs({ messageId: "MSG1" });
    const first = await sendGuardedReply(obs, "hello", { source: "reply-agent", id: "rd_others" });
    expect(first.sent).toBe(true);
    expect(send).toHaveBeenCalledWith("alice@s.whatsapp.net", "hello");
    expect(hasRepliedTo(obs)).toBe(true);

    const second = await sendGuardedReply(obs, "again", { source: "message-handler", id: "mh_1" });
    expect(second).toMatchObject({ sent: false, reason: "already replied to this message" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rate limits a second reply to the same chat inside the interval", async () => {
    const chat = "dave@s.whatsapp.net";
    const r1 = await sendGuardedReply(makeObs({ senderJid: chat, chatJid: chat, messageId: "D1" }), "a", { source: "reply-agent", id: "x" });
    expect(r1.sent).toBe(true);
    expect(canReply(chat, false)).toBe(false);
    const r2 = await sendGuardedReply(makeObs({ senderJid: chat, chatJid: chat, messageId: "D2" }), "b", { source: "reply-agent", id: "x" });
    expect(r2).toMatchObject({ sent: false, reason: "rate limited" });
    // Cooldown is persisted
    const persisted = JSON.parse(readFileSync(join(brainDir, "reply-cooldowns.json"), "utf-8"));
    expect(persisted[chat].repliesInWindow).toBe(1);
  });

  it("rejects non-WhatsApp sources", async () => {
    const r = await sendGuardedReply(makeObs({ source: "slack", messageId: "S1" }), "x", { source: "reply-agent", id: "x" });
    expect(r).toMatchObject({ sent: false, reason: "non-WhatsApp source (slack)" });
    expect(send).not.toHaveBeenCalled();
  });

  it("records an opt-out persistently and refuses later replies", async () => {
    const chat = "erin@s.whatsapp.net";
    const r = await sendGuardedReply(makeObs({ senderJid: chat, chatJid: chat, text: "stop", messageId: "E1" }), "x", { source: "reply-agent", id: "x" });
    expect(r).toMatchObject({ sent: false, reason: "chat opted out" });
    expect(isOptedOut(chat)).toBe(true);
    expect(JSON.parse(readFileSync(join(brainDir, "reply-opt-outs.json"), "utf-8"))[chat]).toBeDefined();

    const later = await sendGuardedReply(makeObs({ senderJid: chat, chatJid: chat, text: "hoe laat is het?", messageId: "E2" }), "x", { source: "reply-agent", id: "x" });
    expect(later).toMatchObject({ sent: false, reason: "chat opted out" });
    expect(clearOptOut(chat)).toBe(true);
    expect(isOptedOut(chat)).toBe(false);
  });

  it("honours the verifier and resolves canonical JIDs", async () => {
    verifyMock.mockReturnValueOnce({ verdict: "blocked", reasons: ["BLOCK: nope"] });
    const obs = makeObs({ senderJid: "123@lid", chatJid: "123@lid", messageId: "L1" });
    const r = await sendGuardedReply(obs, "x", { source: "reply-agent", id: "x" });
    expect(r.sent).toBe(false);
    expect(r.chatJid).toBe("123@s.whatsapp.net");
    expect(verifyMock).toHaveBeenCalledWith(expect.objectContaining({ targetJid: "123@s.whatsapp.net", source: "reply-agent" }));
  });

  it("reports send failures without throwing", async () => {
    send.mockRejectedValueOnce(new Error("socket closed"));
    const r = await sendGuardedReply(makeObs({ senderJid: "f@s.whatsapp.net", chatJid: "f@s.whatsapp.net", messageId: "F1" }), "x", { source: "reply-agent", id: "x" });
    expect(r).toMatchObject({ sent: false, reason: "send failed", sendError: "Error: socket closed" });
  });
});

describe("dispatchReply", () => {
  it("writes an audit log entry for sent replies", async () => {
    const send = vi.fn(async () => {});
    initReplyAgent(send);
    const chat = "gina@s.whatsapp.net";
    await dispatchReply(makeObs({ senderJid: chat, chatJid: chat, messageId: "G1" }), { shouldReply: true, reply: "sure", reason: "ok" }, "rd_others");
    expect(send).toHaveBeenCalledTimes(1);
    expect(existsSync(join(brainDir, "reply-agent-log.jsonl"))).toBe(true);
    const entries = getReplyLog(10, chat);
    expect(entries).toHaveLength(1);
    expect(entries[0].sent).toBe(true);
  });
});
