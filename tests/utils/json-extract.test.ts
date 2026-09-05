import { describe, it, expect } from "vitest";
import { extractJsonObjectCandidates, parseLastJsonObject } from "../../backend/utils/json-extract.js";

describe("extractJsonObjectCandidates", () => {
  it("returns every top-level object in order", () => {
    const raw = 'prose {"a":1} more {"b":{"c":2}} tail';
    expect(extractJsonObjectCandidates(raw)).toEqual(['{"a":1}', '{"b":{"c":2}}']);
  });

  it("ignores braces inside strings", () => {
    const raw = '{"text":"a } b { c","ok":true}';
    expect(extractJsonObjectCandidates(raw)).toEqual([raw]);
  });

  it("handles escaped quotes inside strings", () => {
    const raw = '{"text":"say \\"hi\\" }","n":1}';
    expect(extractJsonObjectCandidates(raw)).toEqual([raw]);
  });

  it("ignores stray closing braces", () => {
    expect(extractJsonObjectCandidates('} } {"a":1}')).toEqual(['{"a":1}']);
  });

  it("returns nothing for unbalanced input", () => {
    expect(extractJsonObjectCandidates('{"a": {"b": 1}')).toEqual([]);
  });
});

describe("parseLastJsonObject", () => {
  it("prefers the last matching object", () => {
    const raw = 'plan: {"success": false, "description": "draft"}\n...done\n{"success": true, "description": "final"}';
    const parsed = parseLastJsonObject<{ success: boolean; description: string }>(raw, p => "success" in p);
    expect(parsed).toEqual({ success: true, description: "final" });
  });

  it("skips trailing objects that do not match the predicate", () => {
    const raw = '{"success": true, "prUrl": "x"} then {"note": "unrelated"}';
    const parsed = parseLastJsonObject(raw, p => "success" in p);
    expect(parsed?.prUrl).toBe("x");
  });

  it("skips invalid JSON candidates", () => {
    const raw = '{"success": true} {not json}';
    expect(parseLastJsonObject(raw, p => "success" in p)).toEqual({ success: true });
  });

  it("returns null when nothing parses", () => {
    expect(parseLastJsonObject("no json here")).toBeNull();
    expect(parseLastJsonObject("{oops}")).toBeNull();
  });

  it("does not get fooled by a greedy first-to-last span", () => {
    // The old regex would grab from the first "{" to the last "}" and fail to parse.
    const raw = 'tool output: {"a": 1}\nresult:\n{"success": true, "description": "ok"}';
    expect(parseLastJsonObject(raw, p => "success" in p)).toEqual({ success: true, description: "ok" });
  });
});
