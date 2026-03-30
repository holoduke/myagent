import { describe, it, expect } from "vitest";
import { splitMessage } from "../../backend/providers/util.js";

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns single chunk for empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("returns single chunk at exactly 4096 chars", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it("splits at newline boundary for long text", () => {
    const line = "x".repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should be <= 4096
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("splits at space when no newline available", () => {
    const words = Array(900).fill("hello").join(" "); // ~5400 chars
    const result = splitMessage(words);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it("hard-splits at 4096 when no good boundary found", () => {
    const text = "a".repeat(5000); // no spaces or newlines
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(4096);
    expect(result[1].length).toBe(904);
  });

  it("handles very long text with multiple splits", () => {
    const text = "a".repeat(12000);
    const result = splitMessage(text);
    expect(result.length).toBe(3);
    const totalLength = result.reduce((sum, c) => sum + c.length, 0);
    expect(totalLength).toBe(12000);
  });

  it("filters out empty chunks from trimming", () => {
    const text = "a".repeat(4000) + "\n" + "b".repeat(4000);
    const result = splitMessage(text);
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("preserves content integrity after splitting", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(100)}`);
    const text = lines.join("\n");
    const result = splitMessage(text);
    const rejoined = result.join("\n");
    // All original lines should be present somewhere in the output
    for (const line of lines) {
      expect(rejoined).toContain(line);
    }
  });
});
