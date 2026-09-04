/**
 * Parse a JSON object out of a raw LLM text response.
 *
 * Models frequently wrap JSON in markdown fences or prose. This strips
 * fences, extracts the outermost `{…}` block and parses it. Returns null
 * when there is no parseable object — callers decide how to degrade.
 */
export function parseJsonResponse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}
