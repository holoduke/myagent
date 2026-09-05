/**
 * Intent classifier for incoming messages.
 *
 * Classifies messages into: command, question, logistics, casual, noise.
 * Pure heuristics (keyword matching, @-mentions, question marks, imperative
 * verbs) — no LLM. Ambiguous messages default to "casual" at low confidence;
 * the unified message evaluator decides separately whether an LLM call is
 * worth it for actionable content or replies.
 *
 * This structured intent-detection pipeline replaces basic detection logic,
 * reducing false positives (responding when shouldn't) and false negatives
 * (missing genuine requests).
 */

export type MessageIntent = "command" | "question" | "logistics" | "casual" | "noise";

export interface IntentClassification {
  intent: MessageIntent;
  confidence: number;  // 0-1
  method: "heuristic" | "llm";
  /** Short reason for classification (e.g. "imperative verb 'remind'") */
  reason: string;
}

// ── Heuristic patterns ──

/** @-mention patterns that signal the message is directed at ARIA */
const ARIA_MENTION_RE = /\b(?:aria|@aria)\b/i;

/** Question indicators */
const QUESTION_RE = /\?\s*$/;
const QUESTION_WORDS_RE = /^(?:what|who|when|where|why|how|is|are|can|could|would|do|does|did|have|has|will|shall|should|wat|wie|wanneer|waar|waarom|hoe|is|zijn|kan|kun|zou|moet|wil|heeft|mag)\b/i;
const QUESTION_PHRASES_RE = /\b(?:do you know|kun je|weet je|heb je|can you tell|could you check|know if|any idea)\b/i;

/** Command / imperative verb indicators (EN + NL) */
const COMMAND_VERBS_RE = /^(?:remind|send|schedule|create|set|add|remove|delete|update|check|find|search|look up|tell|show|list|get|make|write|call|email|message|plan|book|order|buy|cancel|stop|start|enable|disable|turn|stuur|zoek|maak|zet|voeg|verwijder|herinner|controleer|vind|toon|plan|boek|bestel|annuleer)\b/i;

/** Direct request patterns */
const REQUEST_PATTERNS_RE = /\b(?:can you|could you|please|would you|i need you to|i want you to|kun je|zou je|wil je|ik wil dat je|graag)\b/i;

/** Logistics / scheduling patterns (EN + NL) */
const LOGISTICS_RE = /\b(?:meeting|appointment|afspraak|vergadering|pickup|ophalen|dropoff|brengen|schedule|planning|agenda|pick up|bring to|haal op|breng naar|available|beschikbaar|free at|vrij om|dinner at|etentje om|reservation|reservering|flight|vlucht|train|trein|hotel|booking|boeking)\b/i;

/** Date/time patterns suggesting logistics */
const DATETIME_RE = /\b(?:tomorrow|morgen|overmorgen|tonight|vanavond|next week|volgende week|at \d{1,2}[.:]\d{2}|om \d{1,2}[.:]\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december))\b/i;

/** Noise / spam patterns */
const NOISE_RE = /\b(?:unsubscribe|uitschrijven|click here|klik hier|limited offer|aanbieding|win a|win een|free gift|gratis|no longer wish|spam|promo(?:tion(?:al)?|tie)?|newsletter|nieuwsbrief|advertisement|advertentie|forward(?:ed)?|doorgestuurd|chain\s*(?:mail|message))\b/i;

/** Media-only or reaction-only messages */
const MEDIA_ONLY_RE = /^(?:\[(?:image|video|audio|sticker|gif|document|contact|location)\]|👍|👎|❤️|😂|😢|🙏|👏|🔥|💯|🎉|✅|❌|👀|🤔|😅|😊|🥰|😍|🤣|😭|ok+|lol+|haha+|ja+|nee+|yes+|no+|nice+|cool+|wow+|oke+|top+|mooi+|prima+|goed+|sure+|thx|thanks|dank|bedankt|dankje|oké)\s*$/i;

/** Greeting / casual patterns */
const CASUAL_RE = /^(?:hey|hi|hello|hoi|hallo|goedemorgen|goedemiddag|goedenavond|good morning|good afternoon|good evening|sup|yo|what's up|hoe gaat het|alles goed|how are you|how's it going)\b/i;

// ── Confidence thresholds ──
const HIGH_CONFIDENCE = 0.9;
const MEDIUM_CONFIDENCE = 0.7;
const LOW_CONFIDENCE = 0.5;

/**
 * Classify a message's intent using fast heuristics.
 * Returns null if the message is ambiguous (no strong pattern).
 */
function classifyWithHeuristics(text: string, senderName: string, isGroup: boolean): IntentClassification | null {
  const trimmed = text.trim();

  // Noise: media-only, reactions, very short non-question
  if (MEDIA_ONLY_RE.test(trimmed)) {
    return { intent: "noise", confidence: HIGH_CONFIDENCE, method: "heuristic", reason: "media/reaction/acknowledgement" };
  }

  // Noise: spam/promotional patterns
  if (NOISE_RE.test(trimmed)) {
    return { intent: "noise", confidence: MEDIUM_CONFIDENCE, method: "heuristic", reason: "spam/promotional keywords" };
  }

  // Very short messages (1-3 chars) that aren't questions → noise
  if (trimmed.length <= 3 && !QUESTION_RE.test(trimmed)) {
    return { intent: "noise", confidence: MEDIUM_CONFIDENCE, method: "heuristic", reason: "very short message" };
  }

  const mentionsAria = ARIA_MENTION_RE.test(trimmed);
  const isQuestion = QUESTION_RE.test(trimmed) || QUESTION_WORDS_RE.test(trimmed);
  const hasQuestionPhrases = QUESTION_PHRASES_RE.test(trimmed);
  const hasCommandVerb = COMMAND_VERBS_RE.test(trimmed);
  const hasRequestPattern = REQUEST_PATTERNS_RE.test(trimmed);
  const hasLogistics = LOGISTICS_RE.test(trimmed);
  const hasDateTime = DATETIME_RE.test(trimmed);
  const isCasualGreeting = CASUAL_RE.test(trimmed) && trimmed.length < 50;

  // In groups, require @-mention for command/question targeting ARIA
  const directedAtAria = !isGroup || mentionsAria;

  // Command: imperative verb or direct request pattern, directed at ARIA
  if (directedAtAria && (hasCommandVerb || hasRequestPattern)) {
    const confidence = mentionsAria ? HIGH_CONFIDENCE : (hasCommandVerb && hasRequestPattern) ? HIGH_CONFIDENCE : MEDIUM_CONFIDENCE;
    const reason = hasCommandVerb ? `imperative verb detected` : `request pattern detected`;
    return { intent: "command", confidence, method: "heuristic", reason: mentionsAria ? `@-mention + ${reason}` : reason };
  }

  // Question: question mark or question words, directed at ARIA
  if (directedAtAria && (isQuestion || hasQuestionPhrases)) {
    const confidence = (isQuestion && QUESTION_WORDS_RE.test(trimmed)) ? HIGH_CONFIDENCE : (isQuestion || hasQuestionPhrases) ? MEDIUM_CONFIDENCE : LOW_CONFIDENCE;
    const reason = isQuestion ? "question mark" : "question phrase";
    return { intent: "question", confidence, method: "heuristic", reason: mentionsAria ? `@-mention + ${reason}` : reason };
  }

  // Logistics: scheduling/event patterns with date/time
  if (hasLogistics || (hasDateTime && trimmed.length > 15)) {
    const confidence = (hasLogistics && hasDateTime) ? HIGH_CONFIDENCE : MEDIUM_CONFIDENCE;
    return { intent: "logistics", confidence, method: "heuristic", reason: hasLogistics ? "logistics keywords" : "date/time reference" };
  }

  // Casual greeting
  if (isCasualGreeting) {
    return { intent: "casual", confidence: HIGH_CONFIDENCE, method: "heuristic", reason: "greeting pattern" };
  }

  // Short casual messages (under 20 chars, no special patterns)
  if (trimmed.length < 20 && !hasCommandVerb && !isQuestion && !hasLogistics) {
    return { intent: "casual", confidence: LOW_CONFIDENCE, method: "heuristic", reason: "short message, no actionable patterns" };
  }

  // Ambiguous — no strong pattern
  return null;
}

/**
 * Synchronous heuristic-only classification.
 * Returns "casual" at low confidence for ambiguous messages.
 */
export function classifyIntentSync(
  text: string,
  senderName: string,
  isGroup: boolean,
): IntentClassification {
  if (!text || text.trim().length === 0) {
    return { intent: "noise", confidence: HIGH_CONFIDENCE, method: "heuristic", reason: "empty message" };
  }

  const result = classifyWithHeuristics(text, senderName, isGroup);
  if (result) return result;

  return { intent: "casual", confidence: LOW_CONFIDENCE, method: "heuristic", reason: "no strong patterns, defaulting to casual" };
}
