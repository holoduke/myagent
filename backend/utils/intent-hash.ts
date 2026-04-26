import { createHash } from "crypto";

const STOPWORDS = new Set([
  "a", "the", "of", "for", "in", "on", "to", "and", "with", "an", "is", "are", "was", "be",
]);

export function normalizeIntentTokens(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input.join(" ") : input;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ");
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0 && !STOPWORDS.has(t));
  const unique = Array.from(new Set(tokens));
  unique.sort();
  return unique;
}

export function hashIntent(input: string | string[]): string {
  const tokens = normalizeIntentTokens(input);
  const h = createHash("sha256");
  h.update(tokens.join(" "));
  return h.digest("hex").slice(0, 12);
}

export function findIntentCollisions<T extends { intent?: { hash?: string }; completedAt?: number }>(
  history: T[],
  targetHash: string,
  withinDays = 30,
): T[] {
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return history.filter(entry =>
    entry.intent?.hash === targetHash &&
    typeof entry.completedAt === "number" &&
    entry.completedAt >= cutoff,
  );
}
