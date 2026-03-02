import { appendFileSync } from "fs";
import type { Observation } from "./observer.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [urgency] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

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

const OWNER_NAME = (process.env.OWNER_NAME || "Owner").toLowerCase();

// ── Urgency Scoring (zero Claude cost) ──

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
  for (const { pattern, score: weight } of COMPILED_URGENCY_PATTERNS) {
    if (weight <= score) break; // remaining patterns have equal or lower scores
    if (pattern.test(text)) {
      score = weight;
      break;
    }
  }

  // Owner mentioned in group
  if (obs.isGroup && text.toLowerCase().includes(OWNER_NAME)) {
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
  const punctCount = (text.match(/[!?]{1}/g) || []).length;
  if (punctCount >= 3) {
    score = Math.max(score, 0.4);
  }

  return Math.min(score, 1.0);
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

  pendingUrgency = Math.max(pendingUrgency, maxUrgency);
}

export function getPendingUrgency(): number {
  return pendingUrgency;
}

export function clearPendingUrgency(): void {
  pendingUrgency = 0;
}
