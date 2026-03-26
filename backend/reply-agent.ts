/**
 * Reply Agent — auto-reply dispatch, directive storage, rate limiting, and logging.
 *
 * Two built-in categories: "whitelisted" and "others", plus per-contact overrides.
 * Each reply directive contains a filter prompt (when to reply) and a reply prompt
 * (how to reply).
 *
 * AI evaluation is handled by the unified message-evaluator.ts — this module
 * handles directive CRUD, rate limiting, sending, and audit logging.
 *
 * Storage: /data/brain/reply-directives.json
 * Log: /data/brain/reply-agent-log.jsonl
 */

import { randomUUID } from "crypto";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { isWhitelisted } from "./contact-whitelist.js";
import { BaseProvider } from "./providers/base-provider.js";
import { createLogger } from "./logger.js";
import type { Observation } from "./observer.js";

const log = createLogger("reply-agent");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const DIRECTIVES_FILE = `${BRAIN_DIR}/reply-directives.json`;
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

// ── Rate limiting ──

interface ChatCooldown {
  lastReplyAt: number;
  repliesInWindow: number;
  windowStart: number;
}

const MIN_REPLY_INTERVAL_MS = 60_000;
const MAX_REPLIES_PER_WINDOW = 5;
const WINDOW_SIZE_MS = 3_600_000;
const GROUP_COOLDOWN_MULTIPLIER = 3;

const cooldowns = new Map<string, ChatCooldown>();

function canReply(chatJid: string, isGroup: boolean): boolean {
  const cd = cooldowns.get(chatJid);
  if (!cd) return true;

  const now = Date.now();
  const interval = isGroup ? MIN_REPLY_INTERVAL_MS * GROUP_COOLDOWN_MULTIPLIER : MIN_REPLY_INTERVAL_MS;

  if (now - cd.lastReplyAt < interval) return false;
  if (now - cd.windowStart > WINDOW_SIZE_MS) return true;

  const maxReplies = isGroup ? Math.ceil(MAX_REPLIES_PER_WINDOW / GROUP_COOLDOWN_MULTIPLIER) : MAX_REPLIES_PER_WINDOW;
  return cd.repliesInWindow < maxReplies;
}

function recordReplyEvent(chatJid: string): void {
  const now = Date.now();
  const cd = cooldowns.get(chatJid);
  if (!cd || now - cd.windowStart > WINDOW_SIZE_MS) {
    cooldowns.set(chatJid, { lastReplyAt: now, repliesInWindow: 1, windowStart: now });
  } else {
    cd.lastReplyAt = now;
    cd.repliesInWindow++;
  }
}

// ── Opt-out detection ──

const OPT_OUT_RE = /\b(?:stop|unsubscribe|opt\s*out|don'?t message me|stop replying|block|stuur niet meer|stop met berichten|niet meer reageren)\b/i;

function isOptOut(text: string): boolean {
  return OPT_OUT_RE.test(text);
}

// ── Storage (write-through cache) ──

let cache: ReplyDirective[] | null = null;

function load(): ReplyDirective[] {
  if (cache) return cache;
  const data = safeReadJSON<ReplyDirective[] | null>(DIRECTIVES_FILE, null as unknown as ReplyDirective[]);
  if (!data) {
    const defaults: ReplyDirective[] = [
      {
        id: "rd_whitelisted",
        category: "whitelisted",
        filterPrompt: "Reply to messages that are directed at Gillis or seem to expect a response. Skip casual chat, reactions, and messages clearly meant for other people in a group.",
        replyPrompt: "Reply as Gillis's AI assistant. Be helpful and friendly. Keep it short. If you don't know the answer, say Gillis will get back to them.",
        enabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "rd_others",
        category: "others",
        filterPrompt: "Only reply if the message is clearly a question or request directed at Gillis that needs a response. Ignore spam, group banter, forwards, and casual conversation.",
        replyPrompt: "Reply briefly and professionally. Say that Gillis is not available right now and will get back to them. Don't make promises or commitments.",
        enabled: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];
    save(defaults);
    return defaults;
  }
  cache = data;
  return cache;
}

function save(directives: ReplyDirective[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(DIRECTIVES_FILE, directives);
  cache = directives;
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
  const directives = load();

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

  directives.push(directive);
  save(directives);
  log(`Added reply directive: ${directive.id} (${params.category || params.contactJid})`);
  return directive;
}

export function updateReplyDirective(
  id: string,
  updates: Partial<Pick<ReplyDirective, "filterPrompt" | "replyPrompt" | "enabled" | "contactName">>,
): ReplyDirective | null {
  const directives = load();
  const directive = directives.find(d => d.id === id);
  if (!directive) return null;

  if (updates.filterPrompt !== undefined) directive.filterPrompt = updates.filterPrompt;
  if (updates.replyPrompt !== undefined) directive.replyPrompt = updates.replyPrompt;
  if (updates.enabled !== undefined) directive.enabled = updates.enabled;
  if (updates.contactName !== undefined) directive.contactName = updates.contactName;
  directive.updatedAt = Date.now();

  save(directives);
  log(`Updated reply directive ${id}: ${JSON.stringify(updates)}`);
  return directive;
}

export function removeReplyDirective(id: string): boolean {
  if (id === "rd_whitelisted" || id === "rd_others") {
    log(`Cannot delete built-in category directive ${id}`);
    return false;
  }
  const directives = load();
  const filtered = directives.filter(d => d.id !== id);
  if (filtered.length === directives.length) return false;
  save(filtered);
  log(`Removed reply directive ${id}`);
  return true;
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

// ── Dispatch (called by observer after unified evaluation) ──

/**
 * Send an auto-reply based on the evaluation result.
 * Handles rate limiting, opt-out detection, sending, and logging.
 * Called from observer.ts after the unified evaluator decides to reply.
 */
export async function dispatchReply(
  obs: Observation,
  decision: ReplyDecision,
  directiveId: string,
): Promise<void> {
  const chatJid = obs.isGroup ? (obs.chatJid || obs.senderJid) : obs.senderJid;

  // Rate limit
  if (!canReply(chatJid, obs.isGroup ?? false)) {
    log(`Rate limited: skipping reply to ${chatJid}`);
    return;
  }

  // Opt-out
  if (isOptOut(obs.text)) {
    log(`Opt-out detected from ${obs.sender} in ${chatJid}`);
    return;
  }

  const logEntry: ReplyLogEntry = {
    timestamp: Date.now(),
    senderJid: obs.senderJid,
    senderName: obs.sender,
    chatJid,
    isGroup: obs.isGroup ?? false,
    groupName: obs.groupName,
    directiveId,
    messageSnippet: obs.text.slice(0, 100),
    decision,
    sent: false,
  };

  if (!sendFn) {
    logEntry.error = "Send function not initialized";
    log("Reply agent: send function not initialized");
  } else {
    try {
      await sendFn(chatJid, decision.reply!);
      logEntry.sent = true;
      recordReplyEvent(chatJid);
      log(`Replied to ${obs.sender} in ${chatJid}: "${decision.reply!.slice(0, 80)}"`);
    } catch (err) {
      logEntry.error = String(err);
      log(`Failed to send reply to ${chatJid}: ${err}`);
    }
  }

  logReply(logEntry);
}

// ── Test endpoint helper ──

/**
 * Test a reply directive with a fake message. Uses the unified evaluator
 * for consistent behavior with the live pipeline.
 */
export async function testReplyDirective(params: {
  directiveId: string;
  testMessage: string;
  senderName: string;
  isGroup: boolean;
  groupName?: string;
}): Promise<ReplyDecision> {
  const directive = getReplyDirective(params.directiveId);
  if (!directive) {
    return { shouldReply: false, reply: null, reason: "Directive not found" };
  }

  // Use a dedicated LLM call for testing (not the unified evaluator,
  // since we want to test the directive in isolation)
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

  const tester = new TestLLM();
  const raw = await tester.run(prompt);
  if (!raw) {
    return { shouldReply: false, reply: null, reason: "LLM evaluation failed" };
  }

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { shouldReply: false, reply: null, reason: "No JSON in response" };
    const parsed = JSON.parse(jsonMatch[0]) as ReplyDecision;
    return {
      shouldReply: !!parsed.shouldReply,
      reply: parsed.reply || null,
      reason: parsed.reason || "no reason given",
    };
  } catch {
    return { shouldReply: false, reply: null, reason: "JSON parse error" };
  }
}

// ── Test-only LLM provider ──

class TestLLM extends BaseProvider {
  readonly name = "reply-test";
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

  /* eslint-disable @typescript-eslint/no-unused-vars */
  async ask(_msg: string) { return { messages: [] as string[] }; }
  async askStreaming(_msg: string, _cb: (t: string) => void) { return { messages: [] as string[] }; }
  resetSession() { /* no-op */ }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  async run(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const { promise } = this.spawnWithTimeout({
        command: "claude",
        args: ["-p", prompt, "--output-format", "json", "--model", "haiku", "--allowedTools", ""],
        env: {
          ANTHROPIC_API_KEY: "",
          CLAUDECODE: "",
          HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
        },
        timeout: 15_000,
        onTimeout: () => log("Test LLM timed out"),
      });

      promise.then(({ code, stdout, stderr }) => {
        if (code !== 0) { log(`Test LLM exited ${code}: ${stderr.slice(0, 200)}`); resolve(null); return; }
        try {
          const resp = JSON.parse(stdout) as { result: string; is_error: boolean };
          if (resp.is_error) { resolve(null); return; }
          resolve(resp.result);
        } catch { resolve(stdout.trim() || null); }
      }).catch(() => resolve(null));
    });
  }
}
