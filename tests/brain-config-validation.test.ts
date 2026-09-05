import { describe, it, expect } from "vitest";
import { validateBrainConfigUpdate, BRAIN_CONFIG_RULES, isValidTimezone } from "../backend/web/brain-config-validation.js";

const ALL_KEYS = Object.keys(BRAIN_CONFIG_RULES);

function expectError(data: Record<string, unknown>, pattern: RegExp): void {
  const r = validateBrainConfigUpdate(data, ALL_KEYS);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(pattern);
}

describe("validateBrainConfigUpdate", () => {
  it("accepts a well-formed update and only copies allowed keys", () => {
    const r = validateBrainConfigUpdate(
      { enabled: true, tickInterval: 60000, selfImproveMaxPerDay: 4, bogus: 1, models: { think: "x" } },
      ALL_KEYS,
    );
    expect(r).toEqual({ ok: true, update: { enabled: true, tickInterval: 60000, selfImproveMaxPerDay: 4 } });
  });

  it("ignores keys outside the caller's allowlist", () => {
    const r = validateBrainConfigUpdate({ enabled: true, tickInterval: 60000 }, ["enabled"]);
    expect(r).toEqual({ ok: true, update: { enabled: true } });
  });

  it("rejects wrong types", () => {
    expectError({ enabled: "true" }, /enabled must be a boolean/);
    expectError({ quietStart: "23" }, /quietStart must be a finite number/);
    expectError({ tickInterval: NaN }, /finite number/);
    expectError({ characterType: 42 }, /characterType must be a string/);
    expectError({ characterCustomPrompt: 42 }, /must be a string/);
  });

  it("rejects out-of-range and non-integer numbers", () => {
    expectError({ quietStart: 25 }, /between 0 and 24/);
    expectError({ selfImproveMaxPerWeek: -1 }, /between 0 and 200/);
    expectError({ tickInterval: 1000 }, /tickInterval must be between/);
    expectError({ maxMessagesPerDay: 1.5 }, /must be an integer/);
    expectError({ selfImproveMinMergeIntervalMs: 2 * 24 * 60 * 60 * 1000 }, /selfImproveMinMergeIntervalMs/);
  });

  it("allows nullable strings only where declared and enforces enums", () => {
    expect(validateBrainConfigUpdate({ characterCustomPrompt: null, detectionPrompt: null }, ALL_KEYS).ok).toBe(true);
    expectError({ ownerTimezone: null }, /ownerTimezone must be a string/);
    expectError({ detectionMode: "magic" }, /one of: regex, prompt, hybrid/);
    expect(validateBrainConfigUpdate({ detectionMode: "hybrid" }, ALL_KEYS).ok).toBe(true);
  });

  it("validates the timezone and prompt lengths", () => {
    expectError({ ownerTimezone: "Mars/Olympus" }, /valid IANA timezone/);
    expect(validateBrainConfigUpdate({ ownerTimezone: "Europe/Amsterdam" }, ALL_KEYS).ok).toBe(true);
    expectError({ characterCustomPrompt: "x".repeat(8001) }, /at most 8000/);
  });

  it("checks archive recall min/max ordering", () => {
    expectError({ archiveRecallMin: 20, archiveRecallMax: 10 }, /archiveRecallMin must not exceed/);
  });

  it("accepts floats for threshold keys", () => {
    expect(validateBrainConfigUpdate({ urgencyInterruptThreshold: 0.75, activationSpreadFactor: 0.6, selfCritiqueThreshold: 6.5 }, ALL_KEYS).ok).toBe(true);
    expectError({ urgencyInterruptThreshold: 1.5 }, /between 0 and 1/);
  });

  it("has a rule for every self-improve key the dashboard exposes", () => {
    for (const key of ["selfImproveMaxPerDay", "selfImproveMinMergeIntervalMs", "selfImproveAutoMerge", "selfImproveMinPerDay"]) {
      expect(BRAIN_CONFIG_RULES[key]).toBeDefined();
    }
  });
});

describe("isValidTimezone", () => {
  it("accepts IANA names and rejects garbage", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Nowhere/Land")).toBe(false);
  });
});
