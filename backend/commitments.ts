/**
 * Commitment extraction utility.
 *
 * Detects commitment-like language in text (e.g. Moltbook posts/comments)
 * so the reflect tick can remind the brain to track public promises as goals.
 */

export interface ExtractedCommitment {
  /** The sentence or phrase containing the commitment */
  text: string;
  /** The commitment pattern that matched */
  pattern: string;
}

/**
 * Patterns that indicate a public commitment or promise.
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
];

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
      if (!seen.has(commitText.toLowerCase())) {
        seen.add(commitText.toLowerCase());
        results.push({ text: commitText, pattern: label });
      }
    }
  }

  return results;
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
