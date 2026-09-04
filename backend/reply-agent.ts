/**
 * Reply Agent — auto-reply dispatch, directive storage, rate limiting, and logging.
 *
 * Two built-in categories: "whitelisted" and "others", plus per-contact overrides.
 * Each reply directive contains a filter prompt (when to reply) and a reply prompt
 * (how to reply).
 *
 * AI evaluation is handled by the unified message-evaluator.ts — this module
 * handles directive CRUD, rate limiting, opt-outs, the guarded send path that
 * every auto-reply (directive pipeline AND user-defined message handlers) goes
 * through, and audit logging.
 *
 * Storage: ${BRAIN_DIR}/reply-directives.json
 *          ${BRAIN_DIR}/reply-cooldowns.json
 *          ${BRAIN_DIR}/reply-opt-outs.json
 * Log:     ${BRAIN_DIR}/reply-agent-log.jsonl
 */

import { randomUUID } from "crypto";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { ensureDir } from "./utils/file-store.js";
import { MergedStore } from "./utils/merged-store.js";
import { parseJsonResponse } from "./utils/llm-json.js";
import { LlmRunner } from "./providers/llm-runner.js";
import { getBrainConfig } from "./brain-config.js";
import { createLogger } from "./logger.js";
import type { Observation } from "./observer.js";
import { verify } from "./action-verifier.js";
import { resolveCanonicalJid, isWhitelisted } from "./contact-whitelist.js";
import { BRAIN_DIR } from "./config.js";

const log = createLogger("reply-agent");

const DIRECTIVES_FILE = `${BRAIN_DIR}/reply-directives.json`;
const COOLDOWNS_FILE = `${BRAIN_DIR}/reply-cooldowns.json`;
const OPT_OUTS_FILE = `${BRAIN_DIR}/reply-opt-outs.json`;
const LOG_FILE = `${BRAIN_DIR}/reply-agent-log.jsonl`;

// ── Types ──

export type ReplyCategory = "whitelisted" | "others";

export interface ReplyDirective {
  id: string;
  /** Set for category defaults ("whitelisted" or "others") */
  category?: ReplyCategory;
  /** Set for per-contact overrides (JID) */
  contactJid?: string;
  /** Display name (per-contact only) */
  contactName?: string;
  /** Instructions for when to reply vs ignore */
  filterPrompt: string;
  /** Instructions for tone, content, rules */
  replyPrompt: string;
  /** Whether this directive is active */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ReplyDecision {
  shouldReply: boolean;
  reply: string | null;
  reason: string;
}

export interface ReplyLogEntry {
  timestamp: number;
  senderJid: string;
  senderName: string;
  chatJid: string;
  isGroup: boolean;
  groupName?: string;
  directiveId: string;
  messageSnippet: string;
  decision: ReplyDecision;
  sent: boolean;
  error?: string;
}

// ── Rate limiting (persisted so cooldowns survive restarts) ──

interface ChatCooldown {
  lastReplyAt: number;
  repliesInWindow: number;
  windowStart: number;
}

type CooldownMap = Record<string, ChatCooldown>;

const MIN_REPLY_INTERVAL_MS = 60_000;
const MAX_REPLIES_PER_WINDOW = 5;
const WINDOW_SIZE_MS = 3_600_000;
const GROUP_COOLDOWN_MULTIPLIER = 3;
const MAX_COOLDOWN_ENTRIES = 500;

const cooldownStore = new MergedStore<CooldownMap>({
  filePath: COOLDOWNS_FILE,
  defaultValue: () => ({}),
  indent: 0,
});

/** True when a reply to this chat is allowed under the interval/window limits. */
export function canReply(chatJid: string, isGroup: boolean): boolean {
  const cd = cooldownStore.get()[chatJid];
  if (!cd) return true;

  const now = Date.now();
  const interval = isGroup ? MIN_REPLY_INTERVAL_MS * GROUP_COOLDOWN_MULTIPLIER : MIN_REPLY_INTERVAL_MS;
  if (now - cd.lastReplyAt < interval) return false;
  if (now - cd.windowStart > WINDOW_SIZE_MS) return true;

  const maxReplies = isGroup ? Math.ceil(MAX_REPLIES_PER_WINDOW / GROUP_COOLDOWN_MULTIPLIER) : MAX_REPLIES_PER_WINDOW;
  return cd.repliesInWindow < maxReplies;
}

function evictStaleCooldowns(map: CooldownMap, now: number): CooldownMap {
  if (Object.keys(map).length <= MAX_COOLDOWN_ENTRIES) return map;
  const cutoff = now - WINDOW_SIZE_MS;
  return Object.fromEntries(Object.entries(map).filter(([, cd]) => cd.lastReplyAt >= cutoff));
}

function recordReplyEvent(chatJid: string): void {
  const now = Date.now();
  cooldownStore.update(map => {
    const cd = map[chatJid];
    const next: ChatCooldown = !cd || now - cd.windowStart > WINDOW_SIZE_MS
      ? { lastReplyAt: now, repliesInWindow: 1, windowStart: now }
      : { ...cd, lastReplyAt: now, repliesInWindow: cd.repliesInWindow + 1 };
    return evictStaleCooldowns({ ...map, [chatJid]: next }, now);
  });
}

// ── Opt-out detection (explicit phrases only, persisted) ──

interface OptOutRecord {
  at: number;
  senderJid: string;
  snippet: string;
}

const optOutStore = new MergedStore<Record<string, OptOutRecord>>({
  filePath: OPT_OUTS_FILE,
  defaultValue: () => ({}),
});

/** The whole message is a stop word. */
const OPT_OUT_WHOLE_UTTERANCE_RE = /^\s*(?:stop|stop it|please stop|stop please|unsubscribe|opt[\s-]*out|block|niet meer|stop ermee|hou op|kappen)\s*[.!]*\s*$/iu;
/** Explicit "stop messaging me" phrasing, EN + NL. */
const OPT_OUT_EXPLICIT_PHRASE_RE = /\b(?:stop (?:replying|messaging|texting|responding)(?: to me)?|don'?t (?:message|text|reply to|respond to) me|stop met (?:berichten|reageren|sturen)|stuur (?:me )?niet(?:s)? meer|niet meer reageren|reageer niet meer|laat me met rust)\b/iu;
/** A stop word addressed to ARIA / "jij" within the same sentence. */
const OPT_OUT_ADDRESSED_RE = /(?:\baria\b|\bjij\b)[^.!?\n]{0,40}?\b(?:stop|niet meer|block)\b|\b(?:stop|niet meer|block)\b[^.!?\n]{0,40}?(?:\baria\b|\bjij\b)/iu;

export function isOptOut(text: string): boolean {
  return OPT_OUT_WHOLE_UTTERANCE_RE.test(text)
    || OPT_OUT_EXPLICIT_PHRASE_RE.test(text)
    || OPT_OUT_ADDRESSED_RE.test(text);
}

export function isOptedOut(chatJid: string): boolean {
  return chatJid in optOutStore.get();
}

export function recordOptOut(chatJid: string, senderJid: string, snippet: string): void {
  optOutStore.update(map => ({
    ...map,
    [chatJid]: { at: Date.now(), senderJid, snippet: snippet.slice(0, 120) },
  }));
  log(`Opt-out recorded for ${chatJid} (from ${senderJid})`);
}

export function clearOptOut(chatJid: string): boolean {
  if (!isOptedOut(chatJid)) return false;
  optOutStore.update(map => Object.fromEntries(Object.entries(map).filter(([jid]) => jid !== chatJid)));
  return true;
}

/**
 * If the observation is an explicit opt-out request, persist it for the chat
 * and return true. Idempotent: an already opted-out chat stays opted out.
 */
export function noteOptOut(obs: Observation, chatJid: string): boolean {
  if (!isOptOut(obs.text)) return false;
  if (!isOptedOut(chatJid)) recordOptOut(chatJid, obs.senderJid, obs.text);
  return true;
}

// ── Directive storage ──

function defaultDirectives(): ReplyDirective[] {
  const now = Date.now();
  return [
    {
      id: "rd_whitelisted",
      category: "whitelisted",
      filterPrompt: "Reply to messages that are directed at Gillis or seem to expect a response. Skip casual chat, reactions, and messages clearly meant for other people in a group.",
      replyPrompt: "Reply as Gillis's AI assistant. Be helpful and friendly. Keep it short. If you don't know the answer, say Gillis will get back to them.",
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "rd_others",
      category: "others",
      filterPrompt: "Only reply if the message is clearly a question or request directed at Gillis that needs a response. Ignore spam, group banter, forwards, and casual conversation.",
      replyPrompt: "Reply briefly and professionally. Say that Gillis is not available right now and will get back to them. Don't make promises or commitments.",
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

const directiveStore = new MergedStore<ReplyDirective[] | null>({
  filePath: DIRECTIVES_FILE,
  defaultValue: () => null,
});

function load(): ReplyDirective[] {
  const data = directiveStore.get();
  if (Array.isArray(data)) return data;
  const defaults = defaultDirectives();
  directiveStore.update(() => defaults);
  return defaults;
}

// ── CRUD ──

export function getReplyDirectives(): ReplyDirective[] {
  return load();
}

export function getReplyDirective(id: string): ReplyDirective | undefined {
  return load().find(d => d.id === id);
}

export function addReplyDirective(params: {
  category?: ReplyCategory;
  contactJid?: string;
  contactName?: string;
  filterPrompt: string;
  replyPrompt: string;
  enabled?: boolean;
}): ReplyDirective {
  const directive: ReplyDirective = {
    id: `rd_${randomUUID().slice(0, 8)}`,
    ...(params.category && { category: params.category }),
    ...(params.contactJid && { contactJid: params.contactJid }),
    ...(params.contactName && { contactName: params.contactName }),
    filterPrompt: params.filterPrompt,
    replyPrompt: params.replyPrompt,
    enabled: params.enabled ?? true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  directiveStore.update(current => [...(current ?? defaultDirectives()), directive]);
  log(`Added reply directive: ${directive.id} (${params.category || params.contactJid})`);
  return directive;
}

export function updateReplyDirective(
  id: string,
  updates: Partial<Pick<ReplyDirective, "filterPrompt" | "replyPrompt" | "enabled" | "contactName">>,
): ReplyDirective | null {
  if (!load().some(d => d.id === id)) return null;

  let updated: ReplyDirective | null = null;
  directiveStore.update(current => (current ?? []).map(d => {
    if (d.id !== id) return d;
    updated = { ...d, ...updates, updatedAt: Date.now() };
    return updated;
  }));
  log(`Updated reply directive ${id}: ${JSON.stringify(updates)}`);
  return updated;
}

export function removeReplyDirective(id: string): boolean {
  if (id === "rd_whitelisted" || id === "rd_others") {
    log(`Cannot delete built-in category directive ${id}`);
    return false;
  }
  if (!load().some(d => d.id === id)) return false;
  directiveStore.update(current => (current ?? []).filter(d => d.id !== id));
  log(`Removed reply directive ${id}`);
  return true;
}

// ── Directive matching ──

/**
 * Resolve the directive that applies to a message. Per-contact / per-group
 * overrides win. Category defaults ("whitelisted" / "others") only apply to
 * private chats: in a group they would make ARIA answer on behalf of the
 * owner in front of everyone unless the group itself was configured.
 */
export function resolveReplyDirective(senderJid: string, chatJid: string | undefined, isGroup: boolean): ReplyDirective | null {
  const directives = load();
  const override = directives.find(d => {
    if (!d.contactJid || !d.enabled) return false;
    return d.contactJid === senderJid || (chatJid !== undefined && d.contactJid === chatJid);
  });
  if (override) return override;
  if (isGroup) return null;
  const category: ReplyCategory = isWhitelisted(senderJid) ? "whitelisted" : "others";
  return directives.find(d => d.category === category && d.enabled) || null;
}

// ── Logging ──

function logReply(entry: ReplyLogEntry): void {
  try {
    ensureDir(BRAIN_DIR);
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    log(`Failed to write reply log: ${err}`);
  }
}

export function getReplyLog(limit = 100, chatJid?: string): ReplyLogEntry[] {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const lines = readFileSync(LOG_FILE, "utf-8").split("\n").filter((l: string) => l.trim());
    const entries: ReplyLogEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ReplyLogEntry;
        if (chatJid && entry.chatJid !== chatJid) continue;
        entries.push(entry);
      } catch { /* skip corrupt lines */ }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

// ── Send function injection ──

type SendFn = (jid: string, text: string) => Promise<void>;
let sendFn: SendFn | null = null;

export function initReplyAgent(send: SendFn): void {
  sendFn = send;
  load(); // Seed defaults
  log("Reply agent initialized");
}

// ── Per-observation replied guard ──
// The directive pipeline and a user-defined handler evaluate the same
// observation independently; only one of them may answer it.

const MAX_REPLIED_KEYS = 500;
const repliedKeys = new Set<string>();

/** Stable identity of an inbound message for reply bookkeeping. */
export function observationReplyKey(obs: Observation): string {
  const chat = obs.chatJid || obs.senderJid;
  if (obs.messageId) return `wa:${chat}:${obs.messageId}`;
  return `${obs.source || "whatsapp"}:${chat}:${obs.senderJid}:${obs.timestamp}:${obs.text.slice(0, 80)}`;
}

function markReplied(key: string): void {
  repliedKeys.add(key);
  if (repliedKeys.size > MAX_REPLIED_KEYS) {
    const oldest = repliedKeys.values().next().value;
    if (oldest !== undefined) repliedKeys.delete(oldest);
  }
}

export function hasRepliedTo(obs: Observation): boolean {
  return repliedKeys.has(observationReplyKey(obs));
}

// ── Guarded send (shared by the directive pipeline and message handlers) ──

export interface GuardedReplyOrigin {
  source: "reply-agent" | "message-handler";
  /** Directive id or handler id, for the verifier audit trail */
  id: string;
}

export type GuardedReplyResult =
  | { sent: true; chatJid: string }
  | { sent: false; chatJid: string; reason: string; sendError?: string };

function guardedReplyPrecheck(obs: Observation, chatJid: string, text: string): string | null {
  if (obs.source && obs.source !== "whatsapp") return `non-WhatsApp source (${obs.source})`;
  if (!text.trim()) return "empty reply text";
  if (repliedKeys.has(observationReplyKey(obs))) return "already replied to this message";
  if (!canReply(chatJid, obs.isGroup ?? false)) return "rate limited";
  if (noteOptOut(obs, chatJid) || isOptedOut(chatJid)) return "chat opted out";
  return null;
}

/**
 * Send an auto-reply with every safety gate applied: WhatsApp-only source,
 * canonical JID resolution, per-message replied guard, per-chat cooldown,
 * persisted opt-outs and the action verifier. Records the cooldown and the
 * replied key on success. Never throws.
 */
export async function sendGuardedReply(
  obs: Observation,
  text: string,
  origin: GuardedReplyOrigin,
): Promise<GuardedReplyResult> {
  // Resolve @lid aliases to the contact's canonical phone JID so the verifier's
  // strict @s.whatsapp.net/@g.us check accepts whitelisted Baileys v7 LID forms.
  const chatJid = resolveCanonicalJid(obs.chatJid || obs.senderJid);
  const replyText = text.trim();

  const skip = guardedReplyPrecheck(obs, chatJid, replyText);
  if (skip) {
    log(`Skipping ${origin.source} reply to ${chatJid} [${origin.id}]: ${skip}`);
    return { sent: false, chatJid, reason: skip };
  }

  const verifyResult = verify({
    type: "send_message",
    source: origin.source,
    targetJid: chatJid,
    messageText: replyText,
    metadata: { originId: origin.id, senderJid: obs.senderJid },
  });
  if (verifyResult.verdict === "blocked") {
    const reason = `verifier blocked: ${verifyResult.reasons.join("; ")}`;
    log(`Verifier blocked ${origin.source} reply to ${chatJid} [${origin.id}]: ${verifyResult.reasons.join("; ")}`);
    return { sent: false, chatJid, reason };
  }

  if (!sendFn) {
    log("Reply agent: send function not initialized");
    return { sent: false, chatJid, reason: "send function not initialized" };
  }

  // Claim the message before the await so a concurrent caller cannot also send.
  markReplied(observationReplyKey(obs));
  try {
    await sendFn(chatJid, replyText);
    recordReplyEvent(chatJid);
    log(`Replied (${origin.source}/${origin.id}) to ${obs.sender} in ${chatJid}: "${replyText.slice(0, 80)}"`);
    return { sent: true, chatJid };
  } catch (err) {
    log(`Failed to send ${origin.source} reply to ${chatJid}: ${err}`);
    return { sent: false, chatJid, reason: "send failed", sendError: String(err) };
  }
}

// ── Dispatch (called by observer after unified evaluation) ──

/**
 * Send an auto-reply based on the evaluation result and write the audit log.
 * Called from observer.ts after the unified evaluator decides to reply.
 */
export async function dispatchReply(
  obs: Observation,
  decision: ReplyDecision,
  directiveId: string,
): Promise<void> {
  const result = await sendGuardedReply(obs, decision.reply ?? "", { source: "reply-agent", id: directiveId });

  // Pre-send gates (cooldown, opt-out, verifier) are logged, not audited;
  // only actual send attempts land in the reply log.
  if (!result.sent && result.sendError === undefined && result.reason !== "send function not initialized") return;

  logReply({
    timestamp: Date.now(),
    senderJid: obs.senderJid,
    senderName: obs.sender,
    chatJid: result.chatJid,
    isGroup: obs.isGroup ?? false,
    groupName: obs.groupName,
    directiveId,
    messageSnippet: obs.text.slice(0, 100),
    decision,
    sent: result.sent,
    ...(result.sent ? {} : { error: result.sendError ?? result.reason }),
  });
}

// ── Test endpoint helper ──

/**
 * Test a reply directive with a fake message. Uses a dedicated LLM call so
 * the directive can be exercised in isolation from the live pipeline.
 */
export async function testReplyDirective(params: {
  directiveId: string;
  testMessage: string;
  senderName: string;
  isGroup: boolean;
  groupName?: string;
}): Promise<ReplyDecision> {
  if (!getBrainConfig().enabled) {
    return { shouldReply: false, reply: null, reason: "Brain is disabled" };
  }

  const directive = getReplyDirective(params.directiveId);
  if (!directive) {
    return { shouldReply: false, reply: null, reason: "Directive not found" };
  }

  const context = params.isGroup
    ? `in group "${params.groupName || "unknown"}"`
    : "private chat";

  const prompt = `You are a WhatsApp reply agent. Based on the directive below, decide whether to reply to this message and craft the reply if so.

═══ FILTER RULES ═══
${directive.filterPrompt}

═══ REPLY RULES ═══
${directive.replyPrompt}

═══ INCOMING MESSAGE ═══
From: ${params.senderName} (${context})
Message: "${params.testMessage}"

Respond ONLY with valid JSON, no markdown, no code fences:
{"shouldReply": true or false, "reply": "your reply text or null if shouldReply is false", "reason": "brief reason for your decision"}`;

  const tester = new LlmRunner({ name: "reply-test", model: getBrainConfig().models?.messageEval });
  const raw = await tester.run(prompt);
  if (!raw) {
    return { shouldReply: false, reply: null, reason: "LLM evaluation failed" };
  }

  const parsed = parseJsonResponse<Partial<ReplyDecision>>(raw);
  if (!parsed) return { shouldReply: false, reply: null, reason: "No JSON in response" };
  return {
    shouldReply: !!parsed.shouldReply,
    reply: parsed.reply || null,
    reason: parsed.reason || "no reason given",
  };
}
