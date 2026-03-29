/**
 * Unified message evaluator.
 *
 * Consolidates intent classification, actionable detection, and reply decisions
 * into a SINGLE lightweight LLM call per incoming message. Replaces the previous
 * 3-pipe approach (intent-classifier LLM + prompt-detector + reply-agent eval).
 *
 * Free pre-checks (heuristics + regex) still run first to skip the LLM call
 * when the message is obviously noise/casual with no actionable content.
 *
 * The LLM call only fires when:
 * 1. Heuristic intent is ambiguous (confidence < threshold), OR
 * 2. The sender is whitelisted and no regex actionable signals were found, OR
 * 3. A reply directive applies to this sender
 */

import { BaseProvider } from "./providers/base-provider.js";
import { createLogger } from "./logger.js";
import { classifyIntentSync } from "./intent-classifier.js";
import type { IntentClassification, MessageIntent } from "./intent-classifier.js";
import { detectActionableContent } from "./actionable.js";
import type { ActionableSignal } from "./actionable.js";
import type { DetectedEvent, DetectedRequest } from "./prompt-detector.js";
import { isWhitelisted } from "./contact-whitelist.js";
import { getBrainConfig } from "./brain-config.js";
import { getReplyDirectives } from "./reply-agent.js";
import type { ReplyDirective, ReplyDecision } from "./reply-agent.js";
import type { Observation } from "./observer.js";

const log = createLogger("evaluator");

// ── Types ──

export interface EvaluationResult {
  /** Intent classification (always present) */
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

// Threshold below which heuristic intent needs LLM confirmation
const HEURISTIC_CONFIDENCE_THRESHOLD = 0.5;

// ── Directive matching (duplicated from reply-agent to avoid circular dep) ──

function resolveReplyDirective(senderJid: string): ReplyDirective | null {
  const directives = getReplyDirectives();
  // Per-contact override
  const override = directives.find(d => d.contactJid && d.contactJid === senderJid && d.enabled);
  if (override) return override;
  // Category default
  const category = isWhitelisted(senderJid) ? "whitelisted" : "others";
  return directives.find(d => d.category === category && d.enabled) || null;
}

// ── LLM provider ──

class EvaluatorLLM extends BaseProvider {
  readonly name = "message-evaluator";
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

   
  async ask(_msg: string) { return { messages: [] as string[] }; }
  async askStreaming(_msg: string, _cb: (t: string) => void) { return { messages: [] as string[] }; }
  resetSession() { /* no-op */ }
   

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
        timeout: 20_000,
        onTimeout: () => log("Evaluator LLM timed out"),
      });

      promise.then(({ code, stdout, stderr }) => {
        if (code !== 0) {
          log(`Evaluator LLM exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
          return;
        }
        try {
          const resp = JSON.parse(stdout) as { result: string; is_error: boolean };
          if (resp.is_error) { log(`Evaluator LLM error: ${resp.result.slice(0, 200)}`); resolve(null); return; }
          resolve(resp.result);
        } catch {
          resolve(stdout.trim() || null);
        }
      }).catch((err) => { log(`Evaluator LLM spawn failed: ${err}`); resolve(null); });
    });
  }
}

const llm = new EvaluatorLLM();

// ── Prompt builder ──

function buildPrompt(obs: Observation, opts: {
  needsIntentLLM: boolean;
  heuristicIntent: IntentClassification | null;
  isContactWhitelisted: boolean;
  regexSignals: ActionableSignal[];
  replyDirective: ReplyDirective | null;
  detectionMode: string;
}): string {
  const context = obs.isGroup ? `in group "${obs.groupName || "unknown"}"` : "private chat";
  const today = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];

  sections.push(`You are a message evaluator. Analyze this WhatsApp message and return a structured JSON assessment. Respond ONLY with valid JSON, no markdown.`);
  sections.push(`\nCurrent date: ${today}`);
  sections.push(`From: ${obs.sender} (${context})`);
  sections.push(`Message: "${obs.text.slice(0, 500)}"`);

  // Intent section
  if (opts.needsIntentLLM) {
    sections.push(`\n═══ INTENT ═══\nClassify intent: "command" (direct request/instruction), "question" (information query), "logistics" (scheduling/events), "casual" (chat/greetings), "noise" (spam/reactions/media).`);
  } else {
    sections.push(`\n═══ INTENT ═══\nIntent already classified as "${opts.heuristicIntent!.intent}" (high confidence). Include this in your response as-is.`);
  }

  // Actionable detection (whitelisted only, if detection mode isn't regex-only)
  if (opts.isContactWhitelisted && opts.detectionMode !== "regex") {
    const config = getBrainConfig();
    const detectionPrompt = config.detectionPrompt || "";
    sections.push(`\n═══ ACTIONABLE CONTENT ═══\nThis is a whitelisted/trusted contact. Detect events, appointments, deadlines, or requests in the message.`);
    if (opts.regexSignals.length > 0) {
      sections.push(`Regex pre-check found: ${opts.regexSignals.map(s => `${s.category}: "${s.snippet}"`).join(", ")}`);
    }
    if (detectionPrompt) {
      sections.push(`Detection rules:\n${detectionPrompt.replace("{today}", today).replace("{sender}", obs.sender).slice(0, 500)}`);
    }
    sections.push(`Extract events as: {"summary":"...", "date":"YYYY-MM-DD", "time":"HH:MM or null", "location":"... or null", "endTime":"HH:MM or null"}`);
    sections.push(`Extract requests as: {"action":"what is asked", "urgency":"low|medium|high"}`);
  }

  // Reply section
  if (opts.replyDirective) {
    sections.push(`\n═══ REPLY EVALUATION ═══`);
    sections.push(`Filter rules: ${opts.replyDirective.filterPrompt}`);
    sections.push(`Reply rules: ${opts.replyDirective.replyPrompt}`);
    sections.push(`Decide: should we auto-reply? If yes, compose the reply text.`);
  }

  // Output format
  const outputFields: string[] = [
    `"intent": "<command|question|logistics|casual|noise>"`,
    `"intentReason": "<brief reason>"`,
  ];
  if (opts.isContactWhitelisted && opts.detectionMode !== "regex") {
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

// ── Parse LLM response ──

interface LLMResponse {
  intent?: string;
  intentReason?: string;
  events?: DetectedEvent[];
  requests?: DetectedRequest[];
  shouldReply?: boolean;
  reply?: string | null;
  replyReason?: string;
}

function parseLLMResponse(raw: string): LLMResponse | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as LLMResponse;
  } catch {
    log(`Failed to parse evaluator response: ${raw.slice(0, 200)}`);
    return null;
  }
}

// ── Main evaluation function ──

/**
 * Evaluate an incoming message through the unified pipeline.
 *
 * 1. Free checks: heuristic intent + regex actionable
 * 2. Determine if LLM call is needed
 * 3. If needed: single LLM call covering intent + actionable + reply
 * 4. Return structured result
 */
export async function evaluateMessage(obs: Observation): Promise<EvaluationResult> {
  const ownerJid = `${process.env.OWNER_PHONE}@s.whatsapp.net`;
  const isOwner = obs.senderJid === ownerJid;
  const isWA = !obs.source || obs.source === "whatsapp";

  // ── Step 1: Free checks ──
  const heuristicIntent = classifyIntentSync(obs.text, obs.sender, obs.isGroup);
  const isContactWhitelisted = isWhitelisted(obs.senderJid);

  // Regex actionable detection (free, whitelisted only)
  let regexSignals: ActionableSignal[] = [];
  if (!obs.isFromMe && isContactWhitelisted) {
    regexSignals = detectActionableContent(obs.text);
  }

  // Reply directive lookup
  let replyDirective: ReplyDirective | null = null;
  if (!obs.isFromMe && !isOwner && isWA) {
    replyDirective = resolveReplyDirective(obs.senderJid);
  }

  // ── Step 2: Do we need the LLM? ──
  const config = getBrainConfig();
  const detectionMode = config.detectionMode || "hybrid";

  const needsIntentLLM = heuristicIntent.confidence < HEURISTIC_CONFIDENCE_THRESHOLD;
  const needsActionableLLM = isContactWhitelisted && !obs.isFromMe && detectionMode !== "regex" &&
    (detectionMode === "prompt" || (detectionMode === "hybrid" && regexSignals.length === 0));
  const needsReplyLLM = replyDirective !== null;

  const needsLLM = !obs.isFromMe && obs.text && (needsIntentLLM || needsActionableLLM || needsReplyLLM);

  // ── Step 3: Base result (no LLM) ──
  const result: EvaluationResult = {
    intent: heuristicIntent,
    regexSignals,
    detectedEvents: [],
    detectedRequests: [],
    llmSignals: [],
    reply: null,
    replyDirectiveId: null,
    usedLLM: false,
  };

  if (!needsLLM) {
    return result;
  }

  // ── Step 4: Single LLM call ──
  const prompt = buildPrompt(obs, {
    needsIntentLLM,
    heuristicIntent: needsIntentLLM ? null : heuristicIntent,
    isContactWhitelisted,
    regexSignals,
    replyDirective,
    detectionMode,
  });

  const raw = await llm.run(prompt);
  result.usedLLM = true;

  if (!raw) {
    log(`Evaluator LLM returned null for "${obs.text.slice(0, 60)}" from ${obs.sender}`);
    return result;
  }

  const parsed = parseLLMResponse(raw);
  if (!parsed) return result;

  // ── Step 5: Map LLM response to result ──

  // Intent
  if (needsIntentLLM && parsed.intent) {
    const validIntents: MessageIntent[] = ["command", "question", "logistics", "casual", "noise"];
    const intent = validIntents.includes(parsed.intent as MessageIntent) ? parsed.intent as MessageIntent : "casual";
    result.intent = {
      intent,
      confidence: 0.7,
      method: "llm",
      reason: parsed.intentReason || "unified evaluator",
    };
  }

  // Actionable events/requests
  if (parsed.events && Array.isArray(parsed.events)) {
    result.detectedEvents = parsed.events.filter(e => e.summary && e.date);
  }
  if (parsed.requests && Array.isArray(parsed.requests)) {
    result.detectedRequests = parsed.requests.filter(r => r.action);
  }

  // Convert to ActionableSignal format for downstream consumers
  if (result.detectedEvents.length > 0 || result.detectedRequests.length > 0) {
    result.llmSignals = [
      ...result.detectedEvents.map(e => ({
        category: "event" as const,
        snippet: `${e.summary}${e.date ? ` (${e.date}${e.time ? ` ${e.time}` : ""})` : ""}`,
        pattern: "unified-evaluator",
      })),
      ...result.detectedRequests.map(r => ({
        category: "request" as const,
        snippet: r.action,
        pattern: "unified-evaluator",
      })),
    ];
  }

  // Reply decision
  if (replyDirective) {
    result.reply = {
      shouldReply: !!parsed.shouldReply,
      reply: parsed.reply || null,
      reason: parsed.replyReason || "no reason given",
    };
    result.replyDirectiveId = replyDirective.id;
  }

  log(`Evaluated ${obs.sender}: intent=${result.intent.intent}, events=${result.detectedEvents.length}, requests=${result.detectedRequests.length}, reply=${result.reply?.shouldReply || false}${result.reply ? ` (reason: ${result.reply.reason}, hasText: ${!!result.reply.reply})` : ""}`);
  return result;
}
