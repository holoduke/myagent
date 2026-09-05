/**
 * Unified message evaluator.
 *
 * Consolidates actionable detection and reply decisions into a SINGLE
 * lightweight LLM call per incoming message. Intent comes from the free
 * heuristic classifier — it never needs the LLM.
 *
 * Free pre-checks (heuristics + regex) run first to skip the LLM call when
 * the message is obviously noise/casual with no actionable content.
 *
 * The LLM call only fires when:
 * 1. The sender is whitelisted, detection mode allows it, no regex actionable
 *    signals were found, and the heuristic intent is not confidently
 *    noise/casual, OR
 * 2. A reply directive applies to this sender AND the reply would actually be
 *    allowed (cooldown, opt-out, injection check) — otherwise the call is
 *    pointless spend.
 *
 * A daily budget caps the total number of evaluator LLM calls.
 */

import { LlmRunner } from "./providers/llm-runner.js";
import { createLogger } from "./logger.js";
import { classifyIntentSync } from "./intent-classifier.js";
import type { IntentClassification } from "./intent-classifier.js";
import { detectActionableContent } from "./actionable.js";
import type { ActionableSignal } from "./actionable.js";
import type { DetectedEvent, DetectedRequest } from "./prompt-detector.js";
import { isWhitelisted, resolveCanonicalJid } from "./contact-whitelist.js";
import { getBrainConfig, getOwnerLocalDate } from "./brain-config.js";
import { resolveReplyDirective, canReply, isOptedOut, noteOptOut } from "./reply-agent.js";
import type { ReplyDirective, ReplyDecision } from "./reply-agent.js";
import type { Observation } from "./observer.js";
import { OWNER_PHONE } from "./config.js";
import { detectInjection, fenceForPrompt } from "./trust.js";
import { parseJsonResponse } from "./utils/llm-json.js";
import { createDailyBudget } from "./utils/daily-budget.js";

const log = createLogger("evaluator");

// ── Types ──

export interface EvaluationResult {
  /** Intent classification (always present, heuristic) */
  intent: IntentClassification;
  /** Actionable signals from regex (free) — always populated */
  regexSignals: ActionableSignal[];
  /** Structured events from LLM detection (whitelisted only) */
  detectedEvents: DetectedEvent[];
  /** Structured requests from LLM detection (whitelisted only) */
  detectedRequests: DetectedRequest[];
  /** LLM-detected actionable signals (converted from events/requests) */
  llmSignals: ActionableSignal[];
  /** Reply decision (if a reply directive applies) */
  reply: ReplyDecision | null;
  /** The directive that was matched for reply, if any */
  replyDirectiveId: string | null;
  /** Whether the LLM was called */
  usedLLM: boolean;
}

// ── LLM budget ──

/** Hard cap on evaluator LLM calls per owner-local day. */
export const EVALUATOR_LLM_DAILY_BUDGET = 300;
const BUDGET_LOG_EVERY = 25;

const llmBudget = createDailyBudget({
  limit: EVALUATOR_LLM_DAILY_BUDGET,
  dayKey: () => getOwnerLocalDate(getBrainConfig().ownerTimezone),
});

export function getEvaluatorBudgetStatus(): { used: number; remaining: number; refused: number } {
  return { used: llmBudget.used(), remaining: llmBudget.remaining(), refused: llmBudget.refused() };
}

function takeBudget(obs: Observation): boolean {
  if (llmBudget.tryConsume()) return true;
  const refused = llmBudget.refused();
  if (refused === 1 || refused % BUDGET_LOG_EVERY === 0) {
    log(`Evaluator LLM budget exhausted (${EVALUATOR_LLM_DAILY_BUDGET}/day) — skipped ${refused} evaluation(s) today, latest from ${obs.sender}`);
  }
  return false;
}

// ── LLM provider ──

// Runner cache — keyed by model so config changes take effect
let _llm: LlmRunner | null = null;
let _llmModel: string | undefined;

function getLlm(): LlmRunner {
  const model = getBrainConfig().models?.messageEval;
  if (!_llm || model !== _llmModel) {
    _llmModel = model;
    _llm = new LlmRunner({ name: "message-evaluator", timeout: 20_000, model });
  }
  return _llm;
}

// ── Prompt builder ──

interface PromptOptions {
  heuristicIntent: IntentClassification;
  wantsActionable: boolean;
  regexSignals: ActionableSignal[];
  replyDirective: ReplyDirective | null;
}

function buildActionableSection(obs: Observation, opts: PromptOptions, today: string): string[] {
  const detectionPrompt = getBrainConfig().detectionPrompt || "";
  const sections = [
    `\n═══ ACTIONABLE CONTENT ═══\nThis is a whitelisted/trusted contact. Detect events, appointments, deadlines, or requests in the message.`,
  ];
  if (opts.regexSignals.length > 0) {
    sections.push(`Regex pre-check found: ${opts.regexSignals.map(s => `${s.category}: "${s.snippet}"`).join(", ")}`);
  }
  if (detectionPrompt) {
    sections.push(`Detection rules:\n${detectionPrompt.replace("{today}", today).replace("{sender}", obs.sender).slice(0, 500)}`);
  }
  sections.push(`Extract events as: {"summary":"...", "date":"YYYY-MM-DD", "time":"HH:MM or null", "location":"... or null", "endTime":"HH:MM or null"}`);
  sections.push(`Extract requests as: {"action":"what is asked", "urgency":"low|medium|high"}`);
  return sections;
}

function buildPrompt(obs: Observation, opts: PromptOptions): string {
  const context = obs.isGroup ? `in group "${obs.groupName || "unknown"}"` : "private chat";
  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];

  sections.push(`You are a message evaluator. Analyze this WhatsApp message and return a structured JSON assessment. Respond ONLY with valid JSON, no markdown.`);
  sections.push(`\nCurrent date: ${today}`);
  sections.push(`From: ${obs.sender} (${context})`);
  sections.push(fenceForPrompt(obs.text, obs.trustLevel));
  sections.push(`\nIntent was classified heuristically as "${opts.heuristicIntent.intent}" (${opts.heuristicIntent.reason}).`);

  if (opts.wantsActionable) {
    sections.push(...buildActionableSection(obs, opts, today));
  }

  if (opts.replyDirective) {
    sections.push(`\n═══ REPLY EVALUATION ═══`);
    sections.push(`Filter rules: ${opts.replyDirective.filterPrompt}`);
    sections.push(`Reply rules: ${opts.replyDirective.replyPrompt}`);
    sections.push(`Decide: should we auto-reply? If yes, compose the reply text.`);
  }

  const outputFields: string[] = [];
  if (opts.wantsActionable) {
    outputFields.push(`"events": [{"summary":"...", "date":"YYYY-MM-DD", "time":"HH:MM or null", "location":"... or null", "endTime":"HH:MM or null"}]`);
    outputFields.push(`"requests": [{"action":"...", "urgency":"low|medium|high"}]`);
  }
  if (opts.replyDirective) {
    outputFields.push(`"shouldReply": true/false`);
    outputFields.push(`"reply": "reply text or null"`);
    outputFields.push(`"replyReason": "brief reason"`);
  }

  sections.push(`\n═══ OUTPUT ═══\nRespond with ONLY this JSON:\n{${outputFields.join(", ")}}`);
  return sections.join("\n");
}

// ── LLM response shape ──

interface LLMResponse {
  events?: DetectedEvent[];
  requests?: DetectedRequest[];
  shouldReply?: boolean;
  reply?: string | null;
  replyReason?: string;
}

// ── Gating helpers ──

const CONFIDENT_SKIP_THRESHOLD = 0.9;

/** Noise/casual with high heuristic confidence: not worth an LLM call for actionable content. */
function isConfidentlyIdle(intent: IntentClassification): boolean {
  return (intent.intent === "noise" || intent.intent === "casual") && intent.confidence >= CONFIDENT_SKIP_THRESHOLD;
}

function needsActionableLLM(opts: {
  isContactWhitelisted: boolean;
  isOwner: boolean;
  detectionMode: string;
  regexSignals: ActionableSignal[];
  intent: IntentClassification;
}): boolean {
  if (!opts.isContactWhitelisted || opts.isOwner) return false;
  if (opts.detectionMode === "regex") return false;
  if (isConfidentlyIdle(opts.intent)) return false;
  return opts.detectionMode === "prompt" || (opts.detectionMode === "hybrid" && opts.regexSignals.length === 0);
}

/**
 * Resolve the reply directive for this message, but only when a reply could
 * actually be sent: cooldown, opt-out and injection checks run BEFORE the LLM
 * so we never pay for a decision that the guarded send would discard.
 */
function resolveSendableDirective(obs: Observation, isOwner: boolean, isWA: boolean): ReplyDirective | null {
  if (obs.isFromMe || isOwner || !isWA) return null;
  const directive = resolveReplyDirective(obs.senderJid, obs.chatJid, obs.isGroup);
  if (!directive) return null;

  const chatJid = resolveCanonicalJid(obs.chatJid || obs.senderJid);
  if (!canReply(chatJid, obs.isGroup)) {
    log(`Reply directive ${directive.id} skipped for ${obs.sender}: chat ${chatJid} is rate limited`);
    return null;
  }
  if (noteOptOut(obs, chatJid) || isOptedOut(chatJid)) {
    log(`Reply directive ${directive.id} skipped for ${obs.sender}: chat ${chatJid} opted out`);
    return null;
  }
  const injection = detectInjection(obs.text);
  if (injection.detected) {
    log(`Reply directive ${directive.id} skipped for ${obs.sender}: injection patterns [${injection.labels.join(", ")}]`);
    return null;
  }
  return directive;
}

// ── Response mapping ──

function toActionableSignals(events: DetectedEvent[], requests: DetectedRequest[]): ActionableSignal[] {
  return [
    ...events.map(e => ({
      category: "event" as const,
      snippet: `${e.summary}${e.date ? ` (${e.date}${e.time ? ` ${e.time}` : ""})` : ""}`,
      pattern: "unified-evaluator",
    })),
    ...requests.map(r => ({
      category: "request" as const,
      snippet: r.action,
      pattern: "unified-evaluator",
    })),
  ];
}

function applyLLMResponse(base: EvaluationResult, parsed: LLMResponse, replyDirective: ReplyDirective | null): EvaluationResult {
  const detectedEvents = Array.isArray(parsed.events) ? parsed.events.filter(e => e.summary && e.date) : [];
  const detectedRequests = Array.isArray(parsed.requests) ? parsed.requests.filter(r => r.action) : [];
  const reply: ReplyDecision | null = replyDirective
    ? {
      shouldReply: !!parsed.shouldReply,
      reply: parsed.reply?.trim() || null,
      reason: parsed.replyReason || "no reason given",
    }
    : null;

  return {
    ...base,
    detectedEvents,
    detectedRequests,
    llmSignals: toActionableSignals(detectedEvents, detectedRequests),
    reply,
    replyDirectiveId: replyDirective ? replyDirective.id : null,
  };
}

// ── Main evaluation function ──

/**
 * Evaluate an incoming message through the unified pipeline.
 *
 * 1. Free checks: heuristic intent + regex actionable
 * 2. Determine if LLM call is needed (and affordable)
 * 3. If needed: single LLM call covering actionable + reply
 * 4. Return structured result
 */
export async function evaluateMessage(obs: Observation): Promise<EvaluationResult> {
  const ownerJid = `${OWNER_PHONE}@s.whatsapp.net`;
  const isOwner = obs.senderJid === ownerJid;
  const isWA = !obs.source || obs.source === "whatsapp";

  // ── Step 1: Free checks ──
  const heuristicIntent = classifyIntentSync(obs.text, obs.sender, obs.isGroup);
  const isContactWhitelisted = isWhitelisted(obs.senderJid);
  const regexSignals = !obs.isFromMe && isContactWhitelisted ? detectActionableContent(obs.text) : [];

  const base: EvaluationResult = {
    intent: heuristicIntent,
    regexSignals,
    detectedEvents: [],
    detectedRequests: [],
    llmSignals: [],
    reply: null,
    replyDirectiveId: null,
    usedLLM: false,
  };

  if (obs.isFromMe || !obs.text) return base;

  // ── Step 2: Do we need the LLM? ──
  const config = getBrainConfig();
  if (!config.enabled) return base; // Master kill switch

  const detectionMode = config.detectionMode || "hybrid";
  const wantsActionable = needsActionableLLM({ isContactWhitelisted, isOwner, detectionMode, regexSignals, intent: heuristicIntent });
  const replyDirective = resolveSendableDirective(obs, isOwner, isWA);

  if (!wantsActionable && !replyDirective) return base;
  if (!takeBudget(obs)) return base;

  // ── Step 3: Single LLM call ──
  const prompt = buildPrompt(obs, { heuristicIntent, wantsActionable, regexSignals, replyDirective });
  const raw = await getLlm().run(prompt);
  const withLLM: EvaluationResult = { ...base, usedLLM: true };

  if (!raw) {
    log(`Evaluator LLM returned null for "${obs.text.slice(0, 60)}" from ${obs.sender}`);
    return withLLM;
  }

  const parsed = parseJsonResponse<LLMResponse>(raw);
  if (!parsed) {
    log(`Failed to parse evaluator response: ${raw.slice(0, 200)}`);
    return withLLM;
  }

  // ── Step 4: Map LLM response to result ──
  const result = applyLLMResponse(withLLM, parsed, replyDirective);
  log(`Evaluated ${obs.sender}: intent=${result.intent.intent}, events=${result.detectedEvents.length}, requests=${result.detectedRequests.length}, reply=${result.reply?.shouldReply || false}${result.reply ? ` (reason: ${result.reply.reason}, hasText: ${!!result.reply.reply})` : ""}`);
  return result;
}
