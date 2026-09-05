/**
 * Balanced-brace JSON extraction from free-form LLM output.
 *
 * LLM workers are asked to "output ONLY a JSON object", but in practice the
 * response often contains prose, tool logs or code fences around it. A greedy
 * first-`{`-to-last-`}` regex breaks as soon as two objects appear in the text.
 * This walker tracks brace depth (string-aware) and returns every top-level
 * object candidate, so callers can pick the last one that matches their shape.
 */

/** Return every top-level `{...}` span in `raw`, in order of appearance. */
export function extractJsonObjectCandidates(raw: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"" && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

/**
 * Parse the LAST top-level JSON object in `raw` that satisfies `accept`.
 * Result JSON is conventionally emitted at the end of a response, so we scan
 * from the back. Returns null when nothing parses / matches.
 */
export function parseLastJsonObject<T = Record<string, unknown>>(
  raw: string,
  accept: (parsed: Record<string, unknown>) => boolean = () => true,
): T | null {
  const candidates = extractJsonObjectCandidates(raw);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && accept(parsed)) {
        return parsed as T;
      }
    } catch {
      // Not valid JSON — keep scanning earlier candidates.
    }
  }
  return null;
}
