/**
 * Pre-send self-critique for proactive/initiative messages.
 * Uses HaikuRunner to score a proposed message 1-10 before sending.
 * Messages scoring below threshold are suppressed with a logged reason.
 */

import { HaikuRunner } from "./providers/haiku-runner.js";
import { getBrainConfig } from "./brain-config.js";
import { createLogger } from "./logger.js";

const log = createLogger("critique");

export interface CritiqueResult {
  score: number;
  reason: string;
  shouldSend: boolean;
}

// Runner cache — keyed by model so config changes take effect
let runner: HaikuRunner | null = null;
let runnerModel: string | undefined;

function getRunner(): HaikuRunner {
  const model = getBrainConfig().models?.selfCritique;
  if (!runner || model !== runnerModel) {
    runnerModel = model;
    runner = new HaikuRunner({ name: "self-critique", timeout: 10_000, model });
  }
  return runner;
}

/**
 * Critique a proposed outgoing message before sending.
 *
 * Evaluates whether the message is warranted, well-timed, and adds value.
 * Returns a score (1-10) and whether the message should be sent.
 *
 * Bypasses for: direct replies to owner, digest messages, disabled config.
 * Fail-open: if critique times out or errors, the message is sent anyway.
 */
export async function critiqueResponse(
  message: string,
  context: {
    isDirectReply?: boolean;
    isDigest?: boolean;
    recentObservationCount?: number;
    hoursSinceLastMessage?: number;
    messagesToday?: number;
    maxMessagesPerDay?: number;
  },
): Promise<CritiqueResult> {
  const cfg = getBrainConfig();
  const threshold = cfg.selfCritiqueThreshold ?? 6;
  const enabled = cfg.selfCritiqueEnabled ?? true;

  // Bypass: disabled
  if (!enabled) {
    return { score: 10, reason: "self-critique disabled", shouldSend: true };
  }

  // Bypass: direct replies to owner (never suppress)
  if (context.isDirectReply) {
    return { score: 10, reason: "direct reply — bypass critique", shouldSend: true };
  }

  // Bypass: digest messages (scheduled, expected)
  if (context.isDigest) {
    return { score: 10, reason: "digest message — bypass critique", shouldSend: true };
  }

  const prompt = `You are a quality gate for an AI assistant's outgoing messages. Score this proposed message 1-10.

PROPOSED MESSAGE:
"${message.slice(0, 500)}"

CONTEXT:
- Recent observations in buffer: ${context.recentObservationCount ?? "unknown"}
- Hours since last message: ${context.hoursSinceLastMessage?.toFixed(1) ?? "unknown"}
- Messages sent today: ${context.messagesToday ?? "unknown"} / ${context.maxMessagesPerDay ?? "unknown"}

CRITERIA (score each 1-10, then average):
1. Is this message WARRANTED? (Is there something to respond to, or is this unsolicited noise?)
2. Is the TIMING right? (Would the recipient appreciate this now?)
3. Does it ADD VALUE? (Does it contain useful info, insight, or emotional support?)
4. Would the OWNER want to receive this right now?

Respond with ONLY valid JSON: {"score": <number 1-10>, "reason": "<brief reason>"}`;

  try {
    const result = await getRunner().run(prompt);

    if (!result) {
      log("Critique returned no result — fail-open, allowing send");
      return { score: 7, reason: "critique unavailable — fail-open", shouldSend: true };
    }

    try {
      const parsed = JSON.parse(result) as { score?: number; reason?: string };
      const score = typeof parsed.score === "number" ? Math.max(1, Math.min(10, parsed.score)) : 7;
      const reason = parsed.reason || "no reason given";
      const shouldSend = score >= threshold;

      if (!shouldSend) {
        log(`Message SUPPRESSED (score ${score}/${threshold}): ${reason} — "${message.slice(0, 80)}..."`);
      } else {
        log(`Message APPROVED (score ${score}/${threshold}): ${reason}`);
      }

      return { score, reason, shouldSend };
    } catch {
      log(`Failed to parse critique response: ${result.slice(0, 200)} — fail-open`);
      return { score: 7, reason: "parse error — fail-open", shouldSend: true };
    }
  } catch (err) {
    log(`Critique error: ${err} — fail-open, allowing send`);
    return { score: 7, reason: "critique error — fail-open", shouldSend: true };
  }
}
