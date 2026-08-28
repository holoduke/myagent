/**
 * Commitment extraction and classification utility.
 *
 * General-purpose accountability layer: detects commitment-like language in
 * ALL outgoing content — Moltbook, WhatsApp, email, brain-generated messages.
 * Classifies commitments by weight so only notable+ ones get tracked as goals.
 */

export interface ExtractedCommitment {
  /** The sentence or phrase containing the commitment */
  text: string;
  /** The commitment pattern that matched */
  pattern: string;
}

export type CommitmentWeight = "trivial" | "notable" | "significant";

export interface ClassifiedCommitment {
  /** The commitment text */
  commitment: string;
  /** Weight classification */
  weight: CommitmentWeight;
  /** The pattern that matched */
  pattern: string;
}

/**
 * Patterns that indicate a commitment or promise.
 * Each regex is designed to match a single sentence/clause.
 */
const COMMITMENT_PATTERNS: { regex: RegExp; label: string }[] = [
  { regex: /\bI will\b[^.!?\n]{5,}/gi, label: "I will" },
  { regex: /\bI'm going to\b[^.!?\n]{5,}/gi, label: "I'm going to" },
  { regex: /\bI'm planning to\b[^.!?\n]{5,}/gi, label: "I'm planning to" },
  { regex: /\bI plan to\b[^.!?\n]{5,}/gi, label: "I plan to" },
  { regex: /\bnext time I'll\b[^.!?\n]{3,}/gi, label: "next time I'll" },
  { regex: /\bI should build\b[^.!?\n]{3,}/gi, label: "I should build" },
  { regex: /\bI should create\b[^.!?\n]{3,}/gi, label: "I should create" },
  { regex: /\bI want to\b[^.!?\n]{5,}/gi, label: "I want to" },
  { regex: /\bI'm committed to\b[^.!?\n]{3,}/gi, label: "I'm committed to" },
  { regex: /\bI promise\b[^.!?\n]{3,}/gi, label: "I promise" },
  { regex: /\bI'll\b[^.!?\n]{5,}/gi, label: "I'll" },
  { regex: /\bgoing to start\b[^.!?\n]{3,}/gi, label: "going to start" },
  { regex: /\bmy goal is\b[^.!?\n]{3,}/gi, label: "my goal is" },
  { regex: /\bexpect me to\b[^.!?\n]{3,}/gi, label: "expect me to" },
  { regex: /\bworking on\b[^.!?\n]{5,}/gi, label: "working on" },
  { regex: /\bstay tuned\b[^.!?\n]{0,}/gi, label: "stay tuned" },
  { regex: /\blet me\b[^.!?\n]{5,}/gi, label: "let me" },
  { regex: /\bI'll look into\b[^.!?\n]{3,}/gi, label: "I'll look into" },
  { regex: /\bI'll check\b[^.!?\n]{3,}/gi, label: "I'll check" },
  { regex: /\bI should\b[^.!?\n]{5,}/gi, label: "I should" },
];

/**
 * Patterns indicating significant (public/visible) commitments.
 * These get elevated weight because they're visible to others.
 */
const SIGNIFICANT_KEYWORDS = [
  "build", "create", "implement", "ship", "launch", "release",
  "feature", "integration", "promise", "committed", "deploy",
];

/**
 * Patterns indicating trivial commitments (quick lookups, checks).
 */
const TRIVIAL_KEYWORDS = [
  "look into", "check", "look at", "see if", "see whether",
  "think about", "consider", "look up",
];

/**
 * JSON keys whose string values typically contain meta-narration / internal
 * reasoning rather than outward-facing promises. Matches inside these fields
 * should be treated as narration and filtered out.
 */
const NARRATION_JSON_KEYS = [
  "summary", "details", "thinking", "reasoning", "notes",
  "narration", "thought", "thoughts", "reflection", "observation",
  "plan", "rationale", "analysis", "context",
];

/**
 * Phrases that signal self-reflective / session-log narration about the
 * prompt, task, or user rather than an actual commitment to act.
 */
const SELF_REFLECTIVE_PHRASES = [
  "the prompt",
  "the system prompt",
  "the user's message",
  "the user message",
  "the task",
  "the request",
  "understand what they need",
  "understand what the user",
  "wait for the user",
  "re-examine",
  "reexamine",
  "compile the final",
  "final output",
  "parse the",
  "think about how",
  "figure out what",
  "format the final",
  "output json",
  "json output",
  "final json",
  "wrapping up",
  "outputting json",
];

/**
 * Returns true if the match at `matchIndex` appears to be meta-narration
 * (inside JSON narration fields, markdown code fences, or self-reflective
 * phrasing) rather than a real commitment.
 *
 * Heuristics are intentionally conservative — we'd rather skip a few real
 * commitments than surface dozens of session-log lines on every reflect.
 */
function isNarrationContext(
  text: string,
  matchIndex: number,
  matchText: string,
): boolean {
  const before = text.slice(0, matchIndex);

  // (b) Inside an unclosed markdown code fence
  const fenceCount = (before.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) return true;

  // (a) Inside a JSON-like narration field value
  // Scan back ~800 chars for the most recent `"key":"` among narration keys.
  // If there are no unescaped `"` between that opener and the match, we're
  // still inside the string value.
  const lookback = Math.max(0, matchIndex - 800);
  const window = text.slice(lookback, matchIndex);
  for (const key of NARRATION_JSON_KEYS) {
    const keyRe = new RegExp(`"${key}"\\s*:\\s*"`, "gi");
    let keyMatch: RegExpExecArray | null;
    let lastOpen = -1;
    while ((keyMatch = keyRe.exec(window)) !== null) {
      lastOpen = keyMatch.index + keyMatch[0].length;
    }
    if (lastOpen >= 0) {
      const between = window.slice(lastOpen);
      // Count unescaped closing quotes
      const closing = between.match(/(?<!\\)"/g) || [];
      if (closing.length === 0) return true;
    }
  }

  // (c) Self-reflective phrasing in the local context around the match
  const windowStart = Math.max(0, matchIndex - 120);
  const windowEnd = Math.min(text.length, matchIndex + matchText.length + 120);
  const ctx = text.slice(windowStart, windowEnd).toLowerCase();
  for (const phrase of SELF_REFLECTIVE_PHRASES) {
    if (ctx.includes(phrase)) return true;
  }

  return false;
}

/**
 * Returns true when the character at index `i` acts as an apostrophe
 * (contraction/possessive) rather than a quote boundary — i.e. it sits
 * between two word characters, as in "I'll" or "ARIA's".
 */
function isApostrophe(s: string, i: number): boolean {
  const prev = i > 0 ? s[i - 1] : "";
  const next = i + 1 < s.length ? s[i + 1] : "";
  return /\w/.test(prev) && /\w/.test(next);
}

/**
 * Returns true if the match at `matchIndex` falls inside quotation marks —
 * straight/curly single or double quotes, or an inline backtick code span.
 * Quoted text is someone else's words or rhetorical material (e.g. an
 * anti-pattern being quoted to criticize it), not a first-person promise.
 *
 * Scoped to the current line: quotes in posts/messages rarely span lines,
 * and line scoping keeps stray apostrophes and quotes elsewhere in the
 * text from skewing the counts. Also covers quoted list items like
 * `- "I will ..."` since the list marker sits on the same line.
 */
function isQuotedContext(text: string, matchIndex: number): boolean {
  const lineStart = text.lastIndexOf("\n", matchIndex - 1) + 1;
  const before = text.slice(lineStart, matchIndex);

  // Inline code span: odd number of backticks before the match on this line
  const backticks = (before.match(/`/g) || []).length;
  if (backticks % 2 === 1) return true;

  // Straight double quotes: an unclosed `"` before the match means we're
  // inside a quotation — unless the opener directly follows a `:`, which
  // indicates a JSON string value (real outgoing content, handled by the
  // narration filter instead).
  let dqOpen = -1;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '"' && (i === 0 || before[i - 1] !== "\\")) {
      dqOpen = dqOpen === -1 ? i : -1;
    }
  }
  if (dqOpen !== -1 && !before.slice(0, dqOpen).trimEnd().endsWith(":")) {
    return true;
  }

  // Curly double quotes: an unclosed “ before the match
  if (before.lastIndexOf("“") > before.lastIndexOf("”")) return true;

  // Curly single quotes: ‘ opens; ’ closes only when it isn't an apostrophe
  let curlySingleOpen = 0;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === "‘") curlySingleOpen++;
    else if (ch === "’" && curlySingleOpen > 0 && !isApostrophe(before, i)) {
      curlySingleOpen--;
    }
  }
  if (curlySingleOpen > 0) return true;

  // Straight single quotes are ambiguous with apostrophes. Only count
  // quote-like occurrences: an opener follows start-of-line, whitespace,
  // or bracket/dash punctuation; anything else non-apostrophe closes.
  let singleOpen = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== "'") continue;
    if (isApostrophe(before, i)) continue;
    const prev = i > 0 ? before[i - 1] : "";
    if (prev === "" || /[\s([{—\-:,>]/.test(prev)) singleOpen++;
    else if (singleOpen > 0) singleOpen--;
  }
  if (singleOpen > 0) return true;

  return false;
}

/**
 * Extract commitment-like phrases from text.
 * Returns deduplicated matches with the pattern that triggered them.
 * Filters out matches that appear to be meta-narration (JSON summary
 * fields, code fences, self-reflective phrasing) or that fall inside
 * quotation marks (someone else's words) rather than real promises.
 */
export function extractCommitments(text: string): ExtractedCommitment[] {
  if (!text || text.length < 10) return [];

  const seen = new Set<string>();
  const results: ExtractedCommitment[] = [];

  for (const { regex, label } of COMMITMENT_PATTERNS) {
    // Reset regex state for each call
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const commitText = match[0].trim();
      if (isNarrationContext(text, match.index, match[0])) continue;
      if (isQuotedContext(text, match.index)) continue;
      if (!seen.has(commitText.toLowerCase())) {
        seen.add(commitText.toLowerCase());
        results.push({ text: commitText, pattern: label });
      }
    }
  }

  return results;
}

/**
 * Classify a single commitment by weight.
 * - trivial: quick lookups/checks (under ~8 words after trigger, or trivial keywords)
 * - notable: tasks requiring follow-up
 * - significant: features/promises with public visibility or substantial scope
 */
export function classifyCommitment(commitmentText: string): ClassifiedCommitment {
  const lower = commitmentText.toLowerCase();

  // Detect pattern
  let matchedPattern = "unknown";
  for (const { regex, label } of COMMITMENT_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(commitmentText)) {
      matchedPattern = label;
      break;
    }
  }

  // Check for significant keywords first
  const hasSignificant = SIGNIFICANT_KEYWORDS.some(kw => lower.includes(kw));
  if (hasSignificant) {
    return { commitment: commitmentText, weight: "significant", pattern: matchedPattern };
  }

  // Check for trivial keywords
  const hasTrivial = TRIVIAL_KEYWORDS.some(kw => lower.includes(kw));
  // Also treat very short commitments as trivial (fewer than 8 words after trigger)
  const wordCount = commitmentText.split(/\s+/).length;
  if (hasTrivial || wordCount < 6) {
    return { commitment: commitmentText, weight: "trivial", pattern: matchedPattern };
  }

  // Default: notable
  return { commitment: commitmentText, weight: "notable", pattern: matchedPattern };
}

/**
 * Extract and classify all commitments from text.
 * Returns only notable and significant commitments (trivial ones are filtered out).
 */
export function extractAndClassifyCommitments(text: string): ClassifiedCommitment[] {
  const raw = extractCommitments(text);
  return raw
    .map(c => classifyCommitment(c.text))
    .filter(c => c.weight !== "trivial");
}

/**
 * Check whether a text contains any commitment-like language.
 * Lighter than extractCommitments() when you only need a boolean.
 */
export function hasCommitments(text: string): boolean {
  if (!text || text.length < 10) return false;
  for (const { regex } of COMMITMENT_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}
