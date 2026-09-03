import type { Observation } from "./observer.js";
import { createLogger } from "./logger.js";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./utils/file-store.js";
import { BRAIN_DIR } from "./config.js";
import { getBrainConfig, getOwnerLocalDate } from "./brain-config.js";

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

// ── High-signal email sender content gating ──
// Emails from Dutch gov / banking / insurance domains often get an intuitive
// urgency boost, but many are routine receipt notifications ("document ontvangen",
// "inzage beschikbaar") with no deadline or required action. Flagging these as
// URGENT erodes the signal quality of the urgency system. Gate urgency on these
// senders: require action/deadline language in the body before treating as urgent.

const HIGH_SIGNAL_EMAIL_DOMAIN_PATTERNS: RegExp[] = [
  // Dutch government
  /@belastingdienst\.nl/i,
  /@(?:[\w.-]+\.)?mijnoverheid\.nl/i,
  /@(?:[\w.-]+\.)?overheid\.nl/i,
  /@logius\.nl/i,
  /@digid\.nl/i,
  /@uwv\.nl/i,
  /@svb\.nl/i,
  /@duo\.nl/i,
  /@rdw\.nl/i,
  /@cjib\.nl/i,
  /@gemeente[\w.-]*\.nl/i,
  // Banking
  /@ing\.nl/i,
  /@rabobank\.nl/i,
  /@abnamro\.nl/i,
  /@snsbank\.nl/i,
  /@asnbank\.nl/i,
  /@triodos\.nl/i,
  /@knab\.nl/i,
  /@bunq\.com/i,
  /@revolut\.com/i,
];

// Action-required / deadline language. If any of these match the email body,
// the urgency keyword score is allowed to stand; otherwise it is capped at a
// "routine-notification" level.
const ACTION_REQUIRED_PATTERNS: RegExp[] = [
  // Dutch — deadlines & action
  /\buiterlijk\b/i,
  /\bvervaldatum\b/i,
  /\bvervalt\b/i,
  /\bdeadline\b/i,
  /\bactie\s+vereist\b/i,
  /\bactie\s+nodig\b/i,
  /\breageer\s+voor\b/i,
  /\breageren\s+voor\b/i,
  /\bbinnen\s+\d+\s+dagen\b/i,
  /\bvoor\s+\d{1,2}[-/]\d{1,2}/i, // voor 30/04, voor 30-4
  // Dutch — payment / filing
  /\bbetaling\b/i,
  /\bte\s+betalen\b/i,
  /\bbetaal(?:\s|$)/i,
  /\bovermaken\b/i,
  /\bopenstaand(?:\s+bedrag)?\b/i,
  /\bachterstand\b/i,
  /\baanmaning\b/i,
  /\bincasso\b/i,
  /\baangifte\b/i,
  /\bafrekening\b/i,
  // English
  /\baction\s+required\b/i,
  /\brespond\s+by\b/i,
  /\bpay\s+(?:by|before)\b/i,
  /\bdue\s+(?:by|before|on)\b/i,
  /\bpayment\s+due\b/i,
  /\boverdue\b/i,
  // Amount-due patterns
  /€\s*\d/,
  /\bEUR\s*\d/i,
  /\b\d+[.,]\d{2}\s*(?:euro|EUR|€)/i,
];

// ── Promotional / bulk email gate ──
// Marketing mail routinely uses urgency vocabulary ("laatste kans", "act now",
// exclamation marks) purely as a sales tactic. If such mail can produce an
// URGENT flag (e.g. Adobe Creative Cloud promo, 2026-09-03), every urgent flag
// needs manual verification and the signal loses its value for genuinely
// time-critical messages. Gate BEFORE urgency scoring: mail from a known
// marketing domain, mail carrying a List-Unsubscribe header, or mail with a
// promo-style subject gets urgency 0, unconditionally — action/deadline
// language in a promo body (prices, "betaal nu") must not override this.

const MARKETING_EMAIL_DOMAIN_PATTERNS: RegExp[] = [
  // Known marketing sender domains
  /@(?:[\w.-]+\.)?mail\.adobe\.com$/i,
  /@(?:[\w.-]+\.)?adobesystems\.com$/i,
  // Bulk-mail / ESP infrastructure domains (only ever send campaign mail)
  /@(?:[\w.-]+\.)?mailchimp(?:app)?\.com$/i,
  /@(?:[\w.-]+\.)?mcsv\.net$/i,
  /@(?:[\w.-]+\.)?sendgrid\.net$/i,
  /@(?:[\w.-]+\.)?mailgun\.(?:com|org)$/i,
  /@(?:[\w.-]+\.)?braze\.com$/i,
  /@(?:[\w.-]+\.)?exacttarget\.com$/i,
  /@(?:[\w.-]+\.)?hubspotemail\.net$/i,
  // Conventional marketing subdomains: mail.x.com, news.x.com, email.x.com, …
  /@(?:mail|e?mail(?:ing)?|news(?:letter)?s?|marketing|promo(?:tions?)?|offers|deals|updates)\.[\w.-]+\.[a-z]{2,}$/i,
];

// Promo-style subject lines (Dutch + English). Matched against the subject
// only — body text is too noisy for these patterns.
const PROMO_SUBJECT_PATTERNS: RegExp[] = [
  // Dutch
  /\bkorting\b/i,
  /\baanbieding(?:en)?\b/i,
  /\bactieprijs\b/i,
  /\blaatste\s+kans\b/i,
  /\balleen\s+vandaag\b/i,
  /\bmis\s+het\s+niet\b/i,
  /\bnieuwsbrief\b/i,
  /\bgratis\s+(?:verzending|proefperiode|maand)\b/i,
  // English
  /\d+\s*%\s*(?:off|korting|discount)/i,
  /\bsale\b/i,
  /\bdeal(?:s)?\b/i,
  /\blimited\s+time\b/i,
  /\blast\s+chance\b/i,
  /\bdon'?t\s+miss\b/i,
  /\bblack\s+friday\b/i,
  /\bcyber\s+monday\b/i,
  /\bnewsletter\b/i,
  /\bfree\s+trial\b/i,
  /\bupgrade\s+(?:now|today)\b/i,
  /\bexclusive\s+offer\b/i,
];

/**
 * Promotional/bulk email that must never receive an urgent flag: known
 * marketing domain, List-Unsubscribe header, or promo-style subject.
 */
export function isPromotionalEmail(obs: Observation): boolean {
  if (obs.source !== "gmail" || obs.isFromMe) return false;
  const addr = getEmailSenderAddress(obs);
  if (MARKETING_EMAIL_DOMAIN_PATTERNS.some(re => re.test(addr))) return true;
  if (obs.emailMeta?.hasListUnsubscribe) return true;
  const subject = obs.emailMeta?.subject ?? "";
  return PROMO_SUBJECT_PATTERNS.some(re => re.test(subject));
}

function getEmailSenderAddress(obs: Observation): string {
  const raw = obs.emailMeta?.from || obs.sender || "";
  const match = /<([^>]+)>/.exec(raw);
  return (match ? match[1] : raw).trim();
}

function isHighSignalEmailSender(obs: Observation): boolean {
  if (obs.source !== "gmail") return false;
  const addr = getEmailSenderAddress(obs);
  return HIGH_SIGNAL_EMAIL_DOMAIN_PATTERNS.some(re => re.test(addr));
}

function hasActionRequiredContent(text: string): boolean {
  return ACTION_REQUIRED_PATTERNS.some(re => re.test(text));
}

/**
 * A high-signal email sender (gov / banking) with no action-required or deadline
 * language in the body — i.e. a routine receipt/notification email. Caller
 * should treat urgency as capped at a routine-notification level.
 */
export function isRoutineEmailNotification(obs: Observation): boolean {
  if (!isHighSignalEmailSender(obs)) return false;
  return !hasActionRequiredContent(obs.text);
}

/** Max urgency allowed for a routine notification from a high-signal domain. */
const ROUTINE_NOTIFICATION_URGENCY_CAP = 0.2;

// ── Urgency Scoring (zero Claude cost) ──

// Urgency decays over time — a 3-hour-old "emergency" is less urgent than a fresh one.
// Half-life of 1 hour: after 1h score is halved, after 2h quartered, etc.
const URGENCY_HALF_LIFE_MS = 60 * 60 * 1000; // 1 hour

export function scoreUrgency(obs: Observation): number {
  if (obs.isFromMe) return 0; // Own messages have no urgency

  // Promo/noise gate: promotional bulk mail never gets an urgent flag,
  // regardless of urgency vocabulary or deadline language in the body.
  if (isPromotionalEmail(obs)) {
    obs.promotionalEmail = true;
    log(`Promotional email from ${getEmailSenderAddress(obs)} — urgency forced to 0 ("${(obs.emailMeta?.subject ?? "").slice(0, 60)}")`);
    return 0;
  }

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

  // Content-aware email urgency gating: for emails from Dutch gov / banking /
  // other high-signal domains, require action-required or deadline language in
  // the body before treating as urgent. Without such content, cap the score at
  // a routine-notification level so inbox receipts like "document ontvangen"
  // do not produce false-urgency flags. Mark the observation for downstream use.
  if (isRoutineEmailNotification(obs)) {
    if (score > ROUTINE_NOTIFICATION_URGENCY_CAP) {
      log(`Capped urgency ${score.toFixed(2)} → ${ROUTINE_NOTIFICATION_URGENCY_CAP} for routine email from ${getEmailSenderAddress(obs)}`);
    }
    score = Math.min(score, ROUTINE_NOTIFICATION_URGENCY_CAP);
    obs.routineNotification = true;
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

// ── Brain Urgent Override (autonomy gate / quota bypass) ──
// The brain may mark an outgoing message as genuinely urgent, with a mandatory
// motivation. Such a message is rerouted onto the scheduled channel, passing
// the autonomy gate, daily quota and min-interval — the contact whitelist and
// the action verifier still gate the actual send. Every override is persisted
// to an audit log and daily-capped, so quota discipline stays intact and each
// exception is inspectable (the dashboard shows the count next to the
// suppressed count). Replaces the fragile manual workaround of hand-writing
// scheduled-messages.json, which was invisible to the gate and the audit trail.

const URGENT_OVERRIDE_LOG_FILE = `${BRAIN_DIR}/urgency-override-log.json`;
export const MAX_URGENT_OVERRIDES_PER_DAY = 2;
const MIN_URGENT_REASON_LENGTH = 20;
const MAX_URGENT_OVERRIDE_ENTRIES = 200;

export interface UrgentOverrideRecord {
  timestamp: number;
  /** Owner-local date the override counts against (daily cap bookkeeping) */
  ownerDate: string;
  targetJid: string;
  reason: string;
  messageSnippet: string;
}

function isUrgentOverrideRecord(entry: unknown): entry is UrgentOverrideRecord {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.timestamp === "number" &&
    typeof e.ownerDate === "string" &&
    typeof e.targetJid === "string" &&
    typeof e.reason === "string" &&
    typeof e.messageSnippet === "string"
  );
}

function loadUrgentOverrideLog(): UrgentOverrideRecord[] {
  const raw = safeReadJSON<unknown>(URGENT_OVERRIDE_LOG_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isUrgentOverrideRecord);
}

/**
 * The urgent flag requires a substantive motivation. Returns the trimmed
 * reason, or null when missing/too short — in which case the flag is ignored
 * and the message follows the normal gate path.
 */
export function validateUrgentReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length >= MIN_URGENT_REASON_LENGTH ? trimmed : null;
}

export function getUrgentOverridesToday(): number {
  const today = getOwnerLocalDate(getBrainConfig().ownerTimezone);
  return loadUrgentOverrideLog().filter(e => e.ownerDate === today).length;
}

export function canUseUrgentOverride(): boolean {
  return getUrgentOverridesToday() < MAX_URGENT_OVERRIDES_PER_DAY;
}

export function recordUrgentOverride(targetJid: string, reason: string, message: string): void {
  const entries = loadUrgentOverrideLog();
  entries.push({
    timestamp: Date.now(),
    ownerDate: getOwnerLocalDate(getBrainConfig().ownerTimezone),
    targetJid,
    reason,
    messageSnippet: message.slice(0, 120),
  });
  const bounded = entries.length > MAX_URGENT_OVERRIDE_ENTRIES
    ? entries.slice(-MAX_URGENT_OVERRIDE_ENTRIES)
    : entries;
  ensureDir(BRAIN_DIR);
  atomicWriteJSON(URGENT_OVERRIDE_LOG_FILE, bounded);
  log(`Urgent override recorded (${getUrgentOverridesToday()}/${MAX_URGENT_OVERRIDES_PER_DAY} today) → ${targetJid}: ${reason}`);
}

/** Most recent overrides, newest first (for dashboard/audit display). */
export function getRecentUrgentOverrides(limit = 20): UrgentOverrideRecord[] {
  return loadUrgentOverrideLog().slice(-limit).reverse();
}
