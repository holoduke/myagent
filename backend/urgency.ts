import type { Observation } from "./observer.js";
import { createLogger } from "./logger.js";

const log = createLogger("urgency");

// ── Keyword Urgency Scores ──

const URGENCY_KEYWORDS: Record<string, number> = {
  // English
  emergency: 0.9,
  critical: 0.8,
  urgent: 0.7,
  asap: 0.6,
  immediately: 0.6,
  "right now": 0.6,
  help: 0.4,
  important: 0.4,
  quickly: 0.3,
  soon: 0.2,
  sos: 0.9,
  "911": 0.9,
  // Dutch
  noodgeval: 0.9,
  spoed: 0.8,
  dringend: 0.7,
  spoedig: 0.6,
  "zo snel mogelijk": 0.6,
  "nu meteen": 0.6,
  hulp: 0.4,
  belangrijk: 0.4,
  snel: 0.3,
  "112": 0.9,
  // Dutch contextual emergency vocabulary
  kapot: 0.4, // broken
  gestolen: 0.7, // stolen
  ziek: 0.3, // sick
  ongeluk: 0.8, // accident
  brand: 0.9, // fire
  overstroming: 0.8, // flood
  inbraak: 0.8, // break-in
  ambulance: 0.9, // ambulance
  politie: 0.7, // police
};

// Pre-compiled regex patterns sorted by score descending.
// Compiled once at module load time so scoreUrgency() can early-exit
// on the first match — any remaining patterns have equal or lower scores.
const COMPILED_URGENCY_PATTERNS: { pattern: RegExp; score: number }[] = Object.entries(URGENCY_KEYWORDS)
  .sort(([, a], [, b]) => b - a)
  .map(([keyword, score]) => ({
    pattern: new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    score,
  }));

import { OWNER_NAME as RAW_OWNER_NAME } from "./config.js";

const OWNER_NAME = RAW_OWNER_NAME.toLowerCase();
const OWNER_NAME_PATTERN = new RegExp(`\\b${OWNER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

// ── Urgency Scoring (zero Claude cost) ──

// Urgency decays over time — a 3-hour-old "emergency" is less urgent than a fresh one.
// Half-life of 1 hour: after 1h score is halved, after 2h quartered, etc.
const URGENCY_HALF_LIFE_MS = 60 * 60 * 1000; // 1 hour

export function scoreUrgency(obs: Observation): number {
  if (obs.isFromMe) return 0; // Own messages have no urgency

  let score = 0;
  const text = obs.text;

  // Direct message base score
  if (!obs.isGroup) {
    score += 0.3;
  }

  // Keyword matching — patterns are sorted by score descending, so once
  // we find a match we can break: no remaining pattern can beat it.
  // Track keyword score separately to avoid DM base score suppressing lower keywords.
  let keywordScore = 0;
  for (const { pattern, score: weight } of COMPILED_URGENCY_PATTERNS) {
    if (weight <= keywordScore) break; // remaining patterns have equal or lower scores
    if (pattern.test(text)) {
      keywordScore = weight;
      break;
    }
  }
  score = Math.max(score, keywordScore);

  // Owner mentioned in group (word-boundary match to avoid substring false positives)
  if (obs.isGroup && OWNER_NAME_PATTERN.test(text)) {
    score = Math.max(score, 0.5);
  }

  // ALL CAPS detection (>50% uppercase, minimum 10 chars)
  if (text.length >= 10) {
    const upperCount = (text.match(/[A-Z]/g) || []).length;
    const letterCount = (text.match(/[A-Za-z]/g) || []).length;
    if (letterCount > 0 && upperCount / letterCount > 0.5) {
      score = Math.max(score, 0.5);
    }
  }

  // High punctuation density (3+ ! or ? marks)
  const punctCount = (text.match(/[!?]/g) || []).length;
  if (punctCount >= 3) {
    score = Math.max(score, 0.4);
  }

  // Apply time decay — stale urgent messages lose urgency over time.
  // Only decay messages older than 5 minutes (fresh messages keep full score).
  const ageMs = Date.now() - obs.timestamp;
  if (ageMs > 5 * 60 * 1000) {
    const decayFactor = Math.pow(0.5, ageMs / URGENCY_HALF_LIFE_MS);
    score *= decayFactor;
  }

  return Math.max(0, Math.min(score, 1.0));
}

// ── Urgency Interrupt Callback ──
// Registered by brain.ts to trigger an immediate tick on high-urgency observations.
// Avoids circular dependency: urgency.ts never imports brain.ts directly.
let urgencyInterruptHandler: ((score: number) => void) | null = null;
let urgencyInterruptThreshold = 0.8;

export function setUrgencyInterruptHandler(
  handler: (score: number) => void,
  threshold: number,
): void {
  urgencyInterruptHandler = handler;
  urgencyInterruptThreshold = threshold;
}

// ── Batch Scoring ──

let pendingUrgency = 0;

export function scoreObservations(observations: Observation[]): void {
  let maxUrgency = 0;

  for (const obs of observations) {
    const urgency = scoreUrgency(obs);
    obs.urgency = urgency;
    if (urgency > maxUrgency) maxUrgency = urgency;
    if (urgency > 0.3) {
      log(`Scored urgency ${urgency.toFixed(2)} for message from ${obs.sender}: "${obs.text.slice(0, 60)}"`);
    }
  }

  // Replace (not accumulate) pending urgency so stale scores don't persist.
  // scoreObservations is called at tick start with current observations,
  // which already have time-decay applied via scoreUrgency().
  pendingUrgency = maxUrgency;
}

/**
 * Score a single observation and trigger an urgency interrupt if it exceeds the threshold.
 * Called at observation-record time so high-urgency messages trigger an immediate brain tick
 * instead of waiting for the next scheduled tick interval.
 */
export function scoreAndMaybeInterrupt(obs: Observation): void {
  const urgency = scoreUrgency(obs);
  obs.urgency = urgency;
  pendingUrgency = Math.max(pendingUrgency, urgency);

  if (urgency >= urgencyInterruptThreshold && urgencyInterruptHandler) {
    log(`High urgency ${urgency.toFixed(2)} from ${obs.sender} — triggering interrupt`);
    urgencyInterruptHandler(urgency);
  }
}

export function getPendingUrgency(): number {
  return pendingUrgency;
}

export function clearPendingUrgency(): void {
  pendingUrgency = 0;
}
