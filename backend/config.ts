import { createLogger } from "./logger.js";

const log = createLogger("config");

// -- Required --
export const OWNER_PHONE = process.env.OWNER_PHONE || "";
export const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

// -- Paths --
export const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
export const DATA_DIR = process.env.DATA_DIR || "/data";

// -- Identity --
export const OWNER_NAME = process.env.OWNER_NAME || "Owner";
export const GITHUB_REPO = process.env.GITHUB_REPO || "";

// -- Timeouts & Limits --
export const CLAUDE_TIMEOUT = Number(process.env.CLAUDE_TIMEOUT) || 300_000;

/** Parse a numeric env var, clamped to [min, max]; unset/blank/NaN → fallback (0 is a valid value). */
function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  const value = Number.isNaN(parsed) ? fallback : parsed;
  return Math.min(Math.max(value, min), max);
}

// -- Deploy safety --
// The instance lease (instance-lease.ts) decides when this container may start
// WhatsApp. WA_STARTUP_DELAY is only an UPPER BOUND on the legacy grace period
// used when no lock file exists at all (i.e. the previous container predates
// the lease and cannot signal its shutdown). Seconds, 0-120, default 40.
export const WA_STARTUP_DELAY = numberEnv("WA_STARTUP_DELAY", 40, 0, 120) * 1000;
// How long SIGTERM waits for the in-flight owner message before exiting (ms).
export const SHUTDOWN_DRAIN_MS = numberEnv("SHUTDOWN_DRAIN_MS", 8_000, 0, 60_000);

// -- Session Compaction --
export const SESSION_MAX_COST_USD = Number(process.env.SESSION_MAX_COST_USD) || 2.0;
export const SESSION_MAX_INPUT_TOKENS = Number(process.env.SESSION_MAX_INPUT_TOKENS) || 100_000;
export const SESSION_MAX_TURNS = Number(process.env.SESSION_MAX_TURNS) || 30;

/**
 * Validate critical config at startup. Logs warnings for missing optional values.
 * Throws for missing required values.
 */
export function validateConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!OWNER_PHONE) errors.push("OWNER_PHONE is required");
  if (!WEB_PASSWORD) warnings.push("WEB_PASSWORD not set — authenticated endpoints will be inaccessible");

  // Validate numeric configs aren't NaN
  if (Number.isNaN(CLAUDE_TIMEOUT)) warnings.push("CLAUDE_TIMEOUT is not a valid number, using default 300000");
  if (Number.isNaN(SESSION_MAX_COST_USD)) warnings.push("SESSION_MAX_COST_USD is not a valid number, using default 2.0");

  for (const w of warnings) log.warn(w);
  if (errors.length > 0) {
    for (const e of errors) log.error(e);
    throw new Error(`Config validation failed: ${errors.join(", ")}`);
  }

  log(`Config validated: BRAIN_DIR=${BRAIN_DIR}, CLAUDE_TIMEOUT=${CLAUDE_TIMEOUT}ms`);
}
