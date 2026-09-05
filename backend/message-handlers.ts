/**
 * Message Handlers — user-defined, prompt-based rules that run on ALL incoming messages.
 *
 * Independent from the whitelist/directive pipeline. Each handler has a 3-tier filter:
 * 1. Scope filter (free): source, sender, group, isGroup, minTextLength
 * 2. Keyword/regex gate (free): optional keywords or regex pattern
 * 3. LLM filter (Haiku): user-defined filterPrompt evaluates the message
 *
 * Actions when matched: flag, reply, memory, webhook
 *
 * Storage: /data/brain/message-handlers.json
 * Log: /data/brain/message-handler-log.jsonl
 */

import { randomUUID } from "crypto";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { parseJsonResponse } from "./utils/llm-json.js";
import { LlmRunner } from "./providers/llm-runner.js";
import { createLogger } from "./logger.js";
import { getBrainConfig } from "./brain-config.js";
import type { Observation } from "./observer.js";
import { BRAIN_DIR } from "./config.js";
import { detectInjection, fenceForPrompt } from "./trust.js";
import { sendGuardedReply, hasRepliedTo } from "./reply-agent.js";

const log = createLogger("msg-handlers");


const HANDLERS_FILE = `${BRAIN_DIR}/message-handlers.json`;
const LOG_FILE = `${BRAIN_DIR}/message-handler-log.jsonl`;

// ── Types ──

export type HandlerActionType = "flag" | "reply" | "memory" | "webhook";

export interface HandlerScope {
  /** Which sources to match (null/empty = all) */
  sources?: Array<Observation["source"]>;
  /** Specific sender JIDs (empty = all) */
  senderJids?: string[];
  /** Specific group JIDs (empty = all) */
  groupJids?: string[];
  /** null = both, true = groups only, false = DMs only */
  isGroup?: boolean | null;
  /** Skip messages from whitelisted contacts */
  excludeWhitelisted?: boolean;
  /** Skip own outgoing messages (default true) */
  excludeFromMe?: boolean;
  /** Minimum text length to consider (default 1) */
  minTextLength?: number;
}

export interface HandlerGate {
  /** Case-insensitive substring keywords (OR logic) */
  keywords?: string[];
  /** JS regex pattern string */
  regexPattern?: string;
  /** Regex flags (default "i") */
  regexFlags?: string;
}

export interface HandlerAction {
  type: HandlerActionType;
  /** type === "flag" */
  flagLabel?: string;
  flagSeverity?: "info" | "warning" | "critical";
  /** type === "reply" */
  replyPrompt?: string;
  /** type === "memory" */
  memoryTag?: string;
  memorySummaryPrompt?: string;
  /** type === "webhook" */
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
}

export interface MessageHandler {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
  scope: HandlerScope;
  gate?: HandlerGate;
  /** User-defined prompt for LLM evaluation (Tier 3) */
  filterPrompt: string;
  action: HandlerAction;
  /** Min ms between LLM calls for this handler */
  cooldownMs?: number;
  /** Max LLM calls per day for this handler */
  maxLLMCallsPerDay?: number;
}

export interface HandlerLogEntry {
  timestamp: number;
  handlerId: string;
  handlerName: string;
  senderJid: string;
  senderName: string;
  chatJid?: string;
  isGroup: boolean;
  groupName?: string;
  messageSnippet: string;
  tier1Passed: boolean;
  tier2Passed: boolean;
  tier3Result?: boolean;
  actionTaken: boolean;
  actionType?: HandlerActionType;
  actionResult?: string;
  error?: string;
  llmLatencyMs?: number;
}

export interface HandlerStats {
  handlerId: string;
  matchesToday: number;
  llmCallsToday: number;
  actionsTakenToday: number;
  lastMatchAt?: number;
}

// ── Write-through cache ──

let cache: MessageHandler[] | null = null;

function load(): MessageHandler[] {
  if (cache) return cache;
  cache = safeReadJSON<MessageHandler[]>(HANDLERS_FILE, []);
  return cache;
}

function save(handlers: MessageHandler[]): void {
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(HANDLERS_FILE, handlers);
  cache = handlers;
}

// ── CRUD ──

export function getHandlers(): MessageHandler[] {
  return load().sort((a, b) => a.priority - b.priority);
}

export function getHandler(id: string): MessageHandler | undefined {
  return load().find(h => h.id === id);
}

export function addHandler(params: {
  name: string;
  description?: string;
  scope: HandlerScope;
  gate?: HandlerGate;
  filterPrompt: string;
  action: HandlerAction;
  cooldownMs?: number;
  maxLLMCallsPerDay?: number;
  enabled?: boolean;
}): MessageHandler {
  const handlers = load();
  const handler: MessageHandler = {
    id: `mh_${randomUUID().slice(0, 8)}`,
    name: params.name,
    description: params.description,
    enabled: params.enabled ?? true,
    priority: handlers.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scope: params.scope,
    gate: params.gate,
    filterPrompt: params.filterPrompt,
    action: params.action,
    cooldownMs: params.cooldownMs,
    maxLLMCallsPerDay: params.maxLLMCallsPerDay,
  };

  handlers.push(handler);
  save(handlers);
  log(`Added handler: ${handler.id} "${handler.name}"`);
  return handler;
}

export function updateHandler(
  id: string,
  updates: Partial<Omit<MessageHandler, "id" | "createdAt">>,
): MessageHandler | null {
  const handlers = load();
  const handler = handlers.find(h => h.id === id);
  if (!handler) return null;

  Object.assign(handler, updates, { updatedAt: Date.now() });
  save(handlers);
  log(`Updated handler ${id}: ${Object.keys(updates).join(", ")}`);
  return handler;
}

export function removeHandler(id: string): boolean {
  const handlers = load();
  const filtered = handlers.filter(h => h.id !== id);
  if (filtered.length === handlers.length) return false;
  save(filtered);
  log(`Removed handler ${id}`);
  return true;
}

// ── Rate limiting ──

interface RateState {
  lastLLMCallAt: number;
  llmCallsToday: number;
  dayStart: number;
}

const rateMap = new Map<string, RateState>();

function getRateState(handlerId: string): RateState {
  const todayStart = new Date().setHours(0, 0, 0, 0);
  let state = rateMap.get(handlerId);
  if (!state || state.dayStart < todayStart) {
    state = { lastLLMCallAt: 0, llmCallsToday: 0, dayStart: todayStart };
    rateMap.set(handlerId, state);
  }
  return state;
}

function canCallLLM(handler: MessageHandler): boolean {
  const state = getRateState(handler.id);
  const now = Date.now();

  if (handler.cooldownMs && now - state.lastLLMCallAt < handler.cooldownMs) return false;
  if (handler.maxLLMCallsPerDay && state.llmCallsToday >= handler.maxLLMCallsPerDay) return false;

  return true;
}

function recordLLMCall(handlerId: string): void {
  const state = getRateState(handlerId);
  state.lastLLMCallAt = Date.now();
  state.llmCallsToday++;
}

// ── Tier 1: Scope filter ──

function matchesScope(obs: Observation, scope: HandlerScope): boolean {
  // Exclude own messages by default
  if (scope.excludeFromMe !== false && obs.isFromMe) return false;

  // Source filter
  if (scope.sources && scope.sources.length > 0) {
    const obsSource = obs.source || "whatsapp";
    if (!scope.sources.includes(obsSource)) return false;
  }

  // Sender filter
  if (scope.senderJids && scope.senderJids.length > 0) {
    if (!scope.senderJids.includes(obs.senderJid)) return false;
  }

  // Group filter
  if (scope.groupJids && scope.groupJids.length > 0) {
    const chatJid = obs.chatJid || obs.senderJid;
    if (!scope.groupJids.includes(chatJid)) return false;
  }

  // isGroup filter
  if (scope.isGroup === true && !obs.isGroup) return false;
  if (scope.isGroup === false && obs.isGroup) return false;

  // Min text length
  const minLen = scope.minTextLength ?? 1;
  if (obs.text.trim().length < minLen) return false;

  return true;
}

// ── Tier 2: Keyword/regex gate ──

function matchesGate(text: string, gate?: HandlerGate): boolean {
  if (!gate) return true; // No gate = all pass

  const hasKeywords = gate.keywords && gate.keywords.length > 0;
  const hasRegex = gate.regexPattern;

  if (!hasKeywords && !hasRegex) return true; // Empty gate = all pass

  const lowerText = text.toLowerCase();

  // Keywords: any match = pass
  if (hasKeywords) {
    for (const kw of gate.keywords!) {
      if (lowerText.includes(kw.toLowerCase())) return true;
    }
  }

  // Regex: match = pass
  if (hasRegex) {
    try {
      const re = new RegExp(gate.regexPattern!, gate.regexFlags || "i");
      if (re.test(text)) return true;
    } catch {
      log(`Invalid regex in gate: ${gate.regexPattern}`);
    }
  }

  return false;
}

// ── Tier 3: LLM evaluation ──

// Runner cache — keyed by model so config changes take effect
let _handlerLlm: LlmRunner | null = null;
let _handlerLlmModel: string | undefined;

function getHandlerLlm(): LlmRunner {
  const model = getBrainConfig().models?.messageEval;
  if (!_handlerLlm || model !== _handlerLlmModel) {
    _handlerLlmModel = model;
    _handlerLlm = new LlmRunner({ name: "handler-evaluator", timeout: 20_000, model });
  }
  return _handlerLlm;
}

function buildFilterPrompt(obs: Observation, handler: MessageHandler): string {
  const context = obs.isGroup ? `in group "${obs.groupName || "unknown"}"` : "private chat";
  const today = new Date().toISOString().slice(0, 10);

  return `You are a message filter. Evaluate whether this message matches the given criteria. Respond ONLY with valid JSON, no markdown.

Current date: ${today}
From: ${obs.sender} (${context})
${fenceForPrompt(obs.text, obs.trustLevel)}

═══ FILTER CRITERIA ═══
${handler.filterPrompt}

═══ OUTPUT ═══
Respond with ONLY: {"match": true/false, "reason": "brief reason"}`;
}

async function evaluateWithLLM(obs: Observation, handler: MessageHandler): Promise<{ match: boolean; reason: string }> {
  const prompt = buildFilterPrompt(obs, handler);
  const start = Date.now();
  const raw = await getHandlerLlm().run(prompt);
  const latency = Date.now() - start;

  if (!raw) {
    return { match: false, reason: `LLM returned null (${latency}ms)` };
  }

  const parsed = parseJsonResponse<{ match?: boolean; reason?: string }>(raw);
  if (!parsed) return { match: false, reason: `No JSON in LLM response: ${raw.slice(0, 100)}` };
  return {
    match: !!parsed.match,
    reason: parsed.reason || "no reason",
  };
}

// ── Action dispatch ──

type SendFn = (jid: string, text: string) => Promise<void>;

/**
 * Kept for API compatibility with index.ts: replies are sent through the
 * reply agent's guarded path (initReplyAgent owns the send function), so the
 * function passed here is not used directly.
 */
export function initMessageHandlers(_send: SendFn): void {
  load(); // Warm cache
  log(`Message handlers initialized (${load().length} handlers)`);
}

async function executeReplyAction(obs: Observation, handler: MessageHandler): Promise<string> {
  const action = handler.action;
  if (!action.replyPrompt) return "reply skipped: no replyPrompt configured";
  if (hasRepliedTo(obs)) return "reply skipped: message already answered";

  const injection = detectInjection(obs.text);
  if (injection.detected) {
    log(`Handler "${handler.name}" reply skipped for ${obs.sender}: injection patterns [${injection.labels.join(", ")}]`);
    return `reply skipped: injection patterns (${injection.labels.join(", ")})`;
  }

  const context = obs.isGroup ? `in group "${obs.groupName || "unknown"}"` : "private chat";
  const replyGenPrompt = `You are composing a WhatsApp reply. Follow these rules strictly.

═══ REPLY RULES ═══
${action.replyPrompt}

═══ INCOMING MESSAGE ═══
From: ${obs.sender} (${context})
${fenceForPrompt(obs.text, obs.trustLevel)}

Respond with ONLY the reply text. No JSON, no quotes, no explanation.`;

  const reply = await getHandlerLlm().run(replyGenPrompt);
  if (!reply) return "reply skipped: LLM returned null";

  const result = await sendGuardedReply(obs, reply, { source: "message-handler", id: handler.id });
  if (result.sent) return `replied: "${reply.trim().slice(0, 80)}"`;
  return result.sendError ? `reply failed: ${result.sendError}` : `reply skipped: ${result.reason}`;
}

async function executeAction(obs: Observation, handler: MessageHandler, llmReason: string): Promise<string> {
  const action = handler.action;

  switch (action.type) {
    case "flag": {
      const entry = {
        timestamp: Date.now(),
        handlerId: handler.id,
        handlerName: handler.name,
        label: action.flagLabel || handler.name,
        severity: action.flagSeverity || "info",
        senderJid: obs.senderJid,
        senderName: obs.sender,
        isGroup: obs.isGroup,
        groupName: obs.groupName,
        message: obs.text.slice(0, 300),
        reason: llmReason,
      };
      const flagFile = `${BRAIN_DIR}/message-handler-flags.jsonl`;
      try {
        ensureDir(BRAIN_DIR);
        appendFileSync(flagFile, JSON.stringify(entry) + "\n");
      } catch (err) {
        log(`Failed to write flag: ${err}`);
      }
      return `flagged: ${entry.label}`;
    }

    case "reply":
      return executeReplyAction(obs, handler);

    case "memory": {
      const memEntry = {
        timestamp: Date.now(),
        handlerId: handler.id,
        tag: action.memoryTag || "handler-match",
        senderName: obs.sender,
        text: obs.text.slice(0, 500),
        reason: llmReason,
      };
      const memFile = `${BRAIN_DIR}/message-handler-memory.jsonl`;
      try {
        ensureDir(BRAIN_DIR);
        appendFileSync(memFile, JSON.stringify(memEntry) + "\n");
      } catch (err) {
        log(`Failed to write memory entry: ${err}`);
      }
      return `memory stored: ${action.memoryTag || "handler-match"}`;
    }

    case "webhook": {
      if (!action.webhookUrl) return "webhook skipped: no URL configured";
      try {
        const payload = {
          handler: handler.name,
          sender: obs.sender,
          senderJid: obs.senderJid,
          isGroup: obs.isGroup,
          groupName: obs.groupName,
          message: obs.text.slice(0, 500),
          reason: llmReason,
          timestamp: Date.now(),
        };
        const resp = await fetch(action.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(action.webhookHeaders || {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        return `webhook ${resp.status}: ${resp.statusText}`;
      } catch (err) {
        return `webhook failed: ${err}`;
      }
    }

    default:
      return `unknown action type: ${(action as HandlerAction).type}`;
  }
}

// ── Logging ──

function logHandlerEvent(entry: HandlerLogEntry): void {
  try {
    ensureDir(BRAIN_DIR);
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    log(`Failed to write handler log: ${err}`);
  }
}

export function getHandlerLog(limit = 100, handlerId?: string): HandlerLogEntry[] {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const lines = readFileSync(LOG_FILE, "utf-8").split("\n").filter(l => l.trim());
    const entries: HandlerLogEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HandlerLogEntry;
        if (handlerId && entry.handlerId !== handlerId) continue;
        entries.push(entry);
      } catch { /* skip corrupt */ }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

export function getHandlerFlags(limit = 50): unknown[] {
  const flagFile = `${BRAIN_DIR}/message-handler-flags.jsonl`;
  try {
    if (!existsSync(flagFile)) return [];
    const lines = readFileSync(flagFile, "utf-8").split("\n").filter(l => l.trim());
    const entries: unknown[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

export function getHandlerStats(): HandlerStats[] {
  const handlers = load();
  const todayStart = new Date().setHours(0, 0, 0, 0);

  // Read today's log entries
  const todayEntries: HandlerLogEntry[] = [];
  try {
    if (existsSync(LOG_FILE)) {
      const lines = readFileSync(LOG_FILE, "utf-8").split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as HandlerLogEntry;
          if (entry.timestamp >= todayStart) todayEntries.push(entry);
        } catch { /* skip */ }
      }
    }
  } catch { /* empty */ }

  return handlers.map(h => {
    const hEntries = todayEntries.filter(e => e.handlerId === h.id);
    return {
      handlerId: h.id,
      matchesToday: hEntries.filter(e => e.tier3Result === true).length,
      llmCallsToday: hEntries.filter(e => e.tier3Result !== undefined).length,
      actionsTakenToday: hEntries.filter(e => e.actionTaken).length,
      lastMatchAt: hEntries.filter(e => e.tier3Result === true).slice(-1)[0]?.timestamp,
    };
  });
}

// ── Whitelist check (lazy import to avoid circular deps) ──

let isWhitelistedFn: ((jid: string) => boolean) | null = null;

async function checkWhitelisted(jid: string): Promise<boolean> {
  if (!isWhitelistedFn) {
    try {
      const mod = await import("./contact-whitelist.js");
      isWhitelistedFn = mod.isWhitelisted;
    } catch {
      return false;
    }
  }
  return isWhitelistedFn(jid);
}

// ── Main pipeline ──

/**
 * Run all enabled message handlers against an observation.
 * Called from observer.ts for every recorded observation.
 */
export async function runMessageHandlers(obs: Observation): Promise<void> {
  // Master kill switch: skip all handler LLM processing when brain is disabled
  if (!getBrainConfig().enabled) return;

  const handlers = getHandlers().filter(h => h.enabled);
  if (handlers.length === 0) return;

  for (const handler of handlers) {
    try {
      await processHandler(obs, handler);
    } catch (err) {
      log(`Handler "${handler.name}" error: ${err}`);
    }
  }
}

async function processHandler(obs: Observation, handler: MessageHandler): Promise<void> {
  // ── Tier 1: Scope ──
  if (!matchesScope(obs, handler.scope)) return;

  // Whitelist exclusion (checked separately to avoid sync import)
  if (handler.scope.excludeWhitelisted) {
    if (await checkWhitelisted(obs.senderJid)) return;
  }

  // ── Tier 2: Gate ──
  if (!matchesGate(obs.text, handler.gate)) return;

  // ── Tier 3: LLM ──
  if (!canCallLLM(handler)) {
    log(`Rate limited handler "${handler.name}" — skipping LLM eval`);
    return;
  }

  recordLLMCall(handler.id);
  const start = Date.now();
  const { match, reason } = await evaluateWithLLM(obs, handler);
  const latency = Date.now() - start;

  const logEntry: HandlerLogEntry = {
    timestamp: Date.now(),
    handlerId: handler.id,
    handlerName: handler.name,
    senderJid: obs.senderJid,
    senderName: obs.sender,
    chatJid: obs.chatJid,
    isGroup: obs.isGroup,
    groupName: obs.groupName,
    messageSnippet: obs.text.slice(0, 100),
    tier1Passed: true,
    tier2Passed: true,
    tier3Result: match,
    actionTaken: false,
    llmLatencyMs: latency,
  };

  if (!match) {
    logHandlerEvent(logEntry);
    return;
  }

  // ── Execute action ──
  try {
    const result = await executeAction(obs, handler, reason);
    logEntry.actionTaken = true;
    logEntry.actionType = handler.action.type;
    logEntry.actionResult = result;
    log(`Handler "${handler.name}" matched ${obs.sender}: ${result}`);
  } catch (err) {
    logEntry.error = String(err);
    log(`Handler "${handler.name}" action failed: ${err}`);
  }

  logHandlerEvent(logEntry);
}

// ── Test helper ──

export async function testHandler(params: {
  handlerId: string;
  testMessage: string;
  senderName: string;
  isGroup: boolean;
  groupName?: string;
}): Promise<{ tier1: boolean; tier2: boolean; tier3?: { match: boolean; reason: string }; error?: string }> {
  const handler = getHandler(params.handlerId);
  if (!handler) return { tier1: false, tier2: false, error: "Handler not found" };

  const fakeObs: Observation = {
    timestamp: Date.now(),
    sender: params.senderName,
    senderJid: "test@s.whatsapp.net",
    isGroup: params.isGroup,
    groupName: params.groupName,
    isFromMe: false,
    text: params.testMessage,
    source: "whatsapp",
  };

  // Tier 1
  const t1 = matchesScope(fakeObs, handler.scope);
  if (!t1) return { tier1: false, tier2: false };

  // Tier 2
  const t2 = matchesGate(fakeObs.text, handler.gate);
  if (!t2) return { tier1: true, tier2: false };

  // Tier 3
  const result = await evaluateWithLLM(fakeObs, handler);
  return { tier1: true, tier2: true, tier3: result };
}
