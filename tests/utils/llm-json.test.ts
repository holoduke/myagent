import { describe, it, expect } from "vitest";
import { parseJsonResponse } from "../../backend/utils/llm-json.js";

describe("parseJsonResponse", () => {
  it("parses a bare JSON object", () => {
    expect(parseJsonResponse<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(parseJsonResponse<{ ok: boolean }>('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  it("extracts the object out of surrounding prose", () => {
    expect(parseJsonResponse<{ x: string }>('Sure! Here it is: {"x": "y"} hope that helps')).toEqual({ x: "y" });
  });

  it("returns null for empty, null or non-JSON input", () => {
    expect(parseJsonResponse(null)).toBeNull();
    expect(parseJsonResponse(undefined)).toBeNull();
    expect(parseJsonResponse("")).toBeNull();
    expect(parseJsonResponse("no json here")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseJsonResponse("{not: valid}")).toBeNull();
  });

  it("returns null for arrays and primitives", () => {
    expect(parseJsonResponse("[1,2]")).toBeNull();
  });
});
