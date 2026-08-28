import { describe, it, expect } from "vitest";
import { extractCommitments, extractAndClassifyCommitments } from "../backend/commitments.js";

describe("extractCommitments — quoted context filtering", () => {
  it("skips today's false positive: quoted anti-pattern in a list item (straight double quotes)", () => {
    const post = [
      "Security fallacies I keep seeing in agent design:",
      '- "I will treat sandbox isolation as a temporary suggestion"',
      '- "I\'ll add auth later, it\'s just a prototype"',
      "Both of these end in breach postmortems.",
    ].join("\n");
    expect(extractCommitments(post)).toEqual([]);
    expect(extractAndClassifyCommitments(post)).toEqual([]);
  });

  it("skips quoted material in straight single quotes", () => {
    const post =
      "The classic excuse is 'I will refactor this next sprint' and it never happens.";
    expect(extractCommitments(post)).toEqual([]);
  });

  it("skips quoted material in curly double quotes", () => {
    const post = "He said “I will ship this tomorrow” but never did.";
    expect(extractCommitments(post)).toEqual([]);
  });

  it("skips quoted material in curly single quotes, tolerating curly apostrophes inside", () => {
    const post =
      "‘I’ll handle it later’ is the fallacy that sinks most projects.";
    expect(extractCommitments(post)).toEqual([]);
  });

  it("skips matches inside inline backtick code spans", () => {
    const post = "The log line `I will retry the connection` shows up on every failure.";
    expect(extractCommitments(post)).toEqual([]);
  });

  it("still extracts a real first-person commitment", () => {
    const post = "I will build a dashboard integration for this next week.";
    const results = extractCommitments(post);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("build a dashboard integration");
  });

  it("is not confused by apostrophes in contractions and possessives", () => {
    const post = "I'll ship the feature tonight, and it's going into ARIA's dashboard.";
    const results = extractCommitments(post);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pattern).toBe("I'll");
  });

  it("extracts a commitment that precedes a quotation on the same line", () => {
    const post = 'I will implement the fix properly — not the "works on my machine" way.';
    const results = extractCommitments(post);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("implement the fix");
  });

  it("does not treat JSON string values as quoted context", () => {
    // Outgoing content wrapped in JSON is real content; the narration filter
    // handles meta fields, the quote filter must not swallow the rest.
    const payload = '{"body": "I promise to ship the integration tomorrow"}';
    const results = extractCommitments(payload);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pattern).toBe("I promise");
  });

  it("still filters JSON narration fields (existing behavior)", () => {
    const payload = '{"summary": "I will wait for the user and parse the response"}';
    expect(extractCommitments(payload)).toEqual([]);
  });

  it("still filters markdown code fences (existing behavior)", () => {
    const post = "Example config:\n```\nI will run this script on boot\n```\nEnd.";
    expect(extractCommitments(post)).toEqual([]);
  });
});
