/**
 * Type/range validation for PUT /api/brain/config.
 *
 * The dashboard is authenticated, but a typo'd value (tickInterval: 0,
 * quietStart: "23", selfImproveMaxPerWeek: -1) would still wedge the brain.
 * Every accepted key has an explicit rule; anything else is rejected with a
 * message the UI can show verbatim.
 */

import type { BrainConfig } from "../brain-config.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Rule =
  | { kind: "boolean" }
  | { kind: "number"; min: number; max: number; integer?: boolean }
  | { kind: "string"; maxLen: number; nullable?: boolean; oneOf?: readonly string[]; timezone?: boolean };

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One rule per key the endpoint accepts (models/preset are handled separately). */
export const BRAIN_CONFIG_RULES: Readonly<Record<string, Rule>> = {
  enabled: { kind: "boolean" },
  maxMessagesPerDay: { kind: "number", min: 0, max: 100, integer: true },
  minMessageInterval: { kind: "number", min: 0, max: 7 * DAY, integer: true },
  quietStart: { kind: "number", min: 0, max: 24, integer: true },
  quietEnd: { kind: "number", min: 0, max: 24, integer: true },
  ownerTimezone: { kind: "string", maxLen: 64, timezone: true },
  thinkCooldown: { kind: "number", min: 0, max: 7 * DAY, integer: true },
  consolidateInterval: { kind: "number", min: 60_000, max: 30 * DAY, integer: true },
  reflectInterval: { kind: "number", min: 60_000, max: 30 * DAY, integer: true },
  tickInterval: { kind: "number", min: 5_000, max: HOUR, integer: true },
  selfImproveEnabled: { kind: "boolean" },
  selfImproveAutoApprove: { kind: "boolean" },
  selfImproveMaxPerWeek: { kind: "number", min: 0, max: 200, integer: true },
  selfImproveMinPerDay: { kind: "number", min: 0, max: 20, integer: true },
  selfImproveDailyHour: { kind: "number", min: 0, max: 23, integer: true },
  selfImproveAutoMerge: { kind: "boolean" },
  selfImproveMaxPerDay: { kind: "number", min: 0, max: 20, integer: true },
  selfImproveMinMergeIntervalMs: { kind: "number", min: 0, max: DAY, integer: true },
  characterType: { kind: "string", maxLen: 64 },
  characterCustomPrompt: { kind: "string", maxLen: 8_000, nullable: true },
  detectionMode: { kind: "string", maxLen: 16, oneOf: ["regex", "prompt", "hybrid"] },
  detectionPrompt: { kind: "string", maxLen: 8_000, nullable: true },
  selfCritiqueEnabled: { kind: "boolean" },
  selfCritiqueThreshold: { kind: "number", min: 1, max: 10 },
  urgencyInterruptThreshold: { kind: "number", min: 0, max: 1 },
  activationSpreadFactor: { kind: "number", min: 0, max: 1 },
  archiveRecallMin: { kind: "number", min: 0, max: 500, integer: true },
  archiveRecallMax: { kind: "number", min: 0, max: 500, integer: true },
  archiveRecallDivisor: { kind: "number", min: 1, max: 100_000, integer: true },
  maxThinkContextNodes: { kind: "number", min: 1, max: 500, integer: true },
};

export type ConfigValidation =
  | { ok: true; update: Partial<BrainConfig> }
  | { ok: false; error: string };

function checkValue(key: string, value: unknown, rule: Rule): string | null {
  if (rule.kind === "boolean") {
    return typeof value === "boolean" ? null : `${key} must be a boolean`;
  }
  if (rule.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a finite number`;
    if (rule.integer && !Number.isInteger(value)) return `${key} must be an integer`;
    if (value < rule.min || value > rule.max) return `${key} must be between ${rule.min} and ${rule.max}`;
    return null;
  }
  if (value === null) return rule.nullable ? null : `${key} must be a string`;
  if (typeof value !== "string") return `${key} must be a string`;
  if (value.length > rule.maxLen) return `${key} must be at most ${rule.maxLen} characters`;
  if (rule.oneOf && !rule.oneOf.includes(value)) return `${key} must be one of: ${rule.oneOf.join(", ")}`;
  if (rule.timezone && !isValidTimezone(value)) return `${key} must be a valid IANA timezone`;
  return null;
}

/** Cross-field checks that single-key rules cannot express. */
function checkRelations(update: Partial<BrainConfig>): string | null {
  const { archiveRecallMin, archiveRecallMax } = update;
  if (archiveRecallMin !== undefined && archiveRecallMax !== undefined && archiveRecallMin > archiveRecallMax) {
    return "archiveRecallMin must not exceed archiveRecallMax";
  }
  return null;
}

/**
 * Validate the scalar keys of a config update. Keys without a rule are ignored
 * (never copied), so the caller's allowlist stays the single source of truth
 * for what is exposed; this module decides whether the value is sane.
 */
export function validateBrainConfigUpdate(
  data: Record<string, unknown>,
  allowedKeys: readonly string[],
): ConfigValidation {
  const update: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (!(key in data)) continue;
    const rule = BRAIN_CONFIG_RULES[key];
    if (!rule) continue;
    const problem = checkValue(key, data[key], rule);
    if (problem) return { ok: false, error: problem };
    update[key] = data[key];
  }
  const relation = checkRelations(update as Partial<BrainConfig>);
  if (relation) return { ok: false, error: relation };
  return { ok: true, update: update as Partial<BrainConfig> };
}
