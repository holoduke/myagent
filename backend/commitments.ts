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
  /** True if the match sits inside worker/session narration (forces trivial). */
  isNarration?: boolean;
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
 * Phrases that indicate the surrounding text is worker/session narration
 * (sub-agent internal monologue, tool-runner output, prompt-scaffolding)
 * rather than an actual commitment to a person. If any of these appear in
 * the commitment text or a 40-char window around it, the match is forced
 * to trivial and dropped by extractAndClassifyCommitments.
 */
const NARRATION_MARKERS = [
  "let me compile",
  "let me re-examine",
  "let me check",
  "let me re-read",
  "i'll wait for the user",
  "gather the output",
  "the user hasn't asked",
  "the prompt says",
  "compile the final output",
  "session log",
];

/** JSON-like payload marker, e.g. {"success":true ...} wrapping the match. */
const JSON_PAYLOAD_REGEX = /\{\s*"[^"]+"\s*:\s*(?:true|false|"[^"]*"|\d+)/;

function isNarrationContext(
  fullText: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(fullText.length, matchIndex + matchLength + 40);
  const window = fullText.substring(start, end).toLowerCase();
  for (const marker of NARRATION_MARKERS) {
    if (window.includes(marker)) return true;
  }
  if (JSON_PAYLOAD_REGEX.test(window)) return true;
  return false;
}

/**
 * Extract commitment-like phrases from text.
 * Returns deduplicated matches with the pattern that triggered them.
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
      const key = commitText.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const narration = isNarrationContext(text, match.index, match[0].length);
        results.push({ text: commitText, pattern: label, isNarration: narration });
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
export function classifyCommitment(
  commitmentText: string,
  isNarration?: boolean,
): ClassifiedCommitment {
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

  // Narration context (worker/session monologue) always downgrades to trivial.
  // Covers embedded narration markers and the commitment text sitting inside a
  // JSON-like payload emitted by sub-agents.
  if (isNarration || NARRATION_MARKERS.some(m => lower.includes(m)) || JSON_PAYLOAD_REGEX.test(commitmentText)) {
    return { commitment: commitmentText, weight: "trivial", pattern: matchedPattern };
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
    .map(c => classifyCommitment(c.text, c.isNarration))
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
