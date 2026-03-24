/**
 * Actionable message detection for whitelisted contacts.
 *
 * Lightweight regex-based scanner that detects actionable content in incoming
 * messages: events/dates, invitations, logistics, requests, deadlines, action items.
 * Bilingual: Dutch + English patterns.
 *
 * Mirrors the commitments.ts pattern: stateless functions, no Claude calls.
 * Signals are injected into the think prompt so the existing Claude call
 * can decide whether to flag them to the owner.
 */

export type ActionableCategory =
  | "event"
  | "invitation"
  | "logistics"
  | "request"
  | "deadline"
  | "action_item";

export interface ActionableSignal {
  /** What kind of actionable content was detected */
  category: ActionableCategory;
  /** The matched text snippet */
  snippet: string;
  /** Which pattern triggered the match */
  pattern: string;
}

interface PatternDef {
  regex: RegExp;
  label: string;
  category: ActionableCategory;
}

/**
 * Bilingual (Dutch + English) patterns for actionable content.
 * Each regex matches a phrase/sentence fragment.
 */
const ACTIONABLE_PATTERNS: PatternDef[] = [
  // ── Events / Dates ──
  { regex: /\b(?:op|on)\s+\d{1,2}\s+(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|may|june|july|august|october|december)\b[^.!?\n]*/gi, label: "date mention", category: "event" },
  { regex: /\b(?:op|on)\s+(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.!?\n]*/gi, label: "day mention", category: "event" },
  { regex: /\b(?:morgen|overmorgen|tomorrow|day after tomorrow)\b[^.!?\n]*/gi, label: "relative date", category: "event" },
  { regex: /\b(?:volgende week|next week|komend weekend|this weekend|volgend weekend|next weekend)\b[^.!?\n]*/gi, label: "relative week", category: "event" },
  { regex: /\b(?:feestje|verjaardag|birthday|party|bruiloft|wedding|ceremonie|ceremony|borrel|drinks|etentje|dinner|lunch)\b[^.!?\n]*/gi, label: "event type", category: "event" },
  { regex: /\bom\s+\d{1,2}[.:]\d{2}\b/gi, label: "time mention (NL)", category: "event" },
  { regex: /\bat\s+\d{1,2}[.:]\d{2}\b/gi, label: "time mention (EN)", category: "event" },

  // ── Invitations ──
  { regex: /\b(?:kom je|ga je mee|zin om|heb je zin|wil je komen|ben je erbij)\b[^.!?\n]*/gi, label: "invitation (NL)", category: "invitation" },
  { regex: /\b(?:want to come|join us|you're invited|are you coming|wanna join|come along|be there)\b[^.!?\n]*/gi, label: "invitation (EN)", category: "invitation" },
  { regex: /\b(?:uitgenodigd|uitnodiging|invited|invitation)\b[^.!?\n]*/gi, label: "invitation explicit", category: "invitation" },

  // ── Logistics ──
  { regex: /\b(?:ophalen|oppikken|afzetten|brengen|pick up|drop off|bring|collect)\b[^.!?\n]*/gi, label: "pickup/dropoff", category: "logistics" },
  { regex: /\b(?:hoe laat|what time|which time|welke tijd)\b[^.!?\n]*/gi, label: "time question", category: "logistics" },
  { regex: /\b(?:waar(?:heen)?|where|locatie|location|adres|address)\b[^.!?\n]{5,}/gi, label: "location question", category: "logistics" },

  // ── Requests ──
  { regex: /\b(?:kun je|kan je|wil je|zou je|could you|can you|would you|will you|please)\b[^.!?\n]{5,}/gi, label: "request", category: "request" },
  { regex: /\b(?:heb je|have you|do you have|heb jij)\b[^.!?\n]{5,}/gi, label: "question/ask", category: "request" },

  // ── Deadlines ──
  { regex: /\b(?:voor|before|uiterlijk|by|deadline|due)\s+(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s+\w+)\b[^.!?\n]*/gi, label: "deadline", category: "deadline" },

  // ── Action Items ──
  { regex: /\b(?:vergeet niet|niet vergeten|denk eraan|don't forget|remember to|remind)\b[^.!?\n]*/gi, label: "reminder", category: "action_item" },
  { regex: /\b(?:moet je|je moet|you need to|you have to|you should|moet nog)\b[^.!?\n]*/gi, label: "obligation", category: "action_item" },
];

/**
 * Detect actionable content in a text message.
 * Returns deduplicated signals with category and matched snippet.
 */
export function detectActionableContent(text: string): ActionableSignal[] {
  if (!text || text.length < 5) return [];

  const seen = new Set<string>();
  const results: ActionableSignal[] = [];

  for (const { regex, label, category } of ACTIONABLE_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const snippet = match[0].trim();
      const key = `${category}:${snippet.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ category, snippet, pattern: label });
      }
    }
  }

  return results;
}

/**
 * Quick boolean check — lighter than full detection when you only need yes/no.
 */
export function hasActionableContent(text: string): boolean {
  if (!text || text.length < 5) return false;
  for (const { regex } of ACTIONABLE_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
