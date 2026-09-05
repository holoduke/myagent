/**
 * Parse a JSON object out of a raw LLM text response.
 *
 * Models frequently wrap JSON in markdown fences or prose. This delegates to
 * the balanced-brace walker in json-extract (string-aware, tolerant of
 * multiple objects) and returns the last parseable object. Returns null when
 * there is no parseable object — callers decide how to degrade.
 */
import { parseLastJsonObject } from "./json-extract.js";

export function parseJsonResponse<T>(raw: string | null | undefined): T | null {
  if (!raw || !raw.trim()) return null;
  return parseLastJsonObject<T>(raw);
}
