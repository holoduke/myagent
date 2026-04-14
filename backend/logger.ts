import { appendFileSync, statSync, renameSync, unlinkSync, existsSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 5;

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

function getConfiguredLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (env in LEVELS) return env as LogLevel;
  return "info";
}

const configuredLevel = getConfiguredLevel();

function rotateIfNeeded(): void {
  try {
    const stats = statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return;

    // Shift existing rotations: .5 -> delete, .4 -> .5, ... .1 -> .2
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const dst = `${LOG_FILE}.${i}`;
      if (existsSync(src)) {
        if (i === MAX_ROTATIONS && existsSync(dst)) {
          unlinkSync(dst);
        }
        renameSync(src, dst);
      }
    }
    // LOG_FILE has been renamed to LOG_FILE.1, next appendFileSync creates a fresh file
  } catch {
    // If rotation fails, continue logging to the current file
  }
}

function emit(level: LogLevel, module: string, msg: string): void {
  if (LEVELS[level] < LEVELS[configuredLevel]) return;

  const tag = level.toUpperCase();
  const line = `[${new Date().toISOString()}] [${tag}] [${module}] ${msg}`;

  // Route to the appropriate console method
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);

  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* prevent disk errors from crashing */ }
}

export interface Logger {
  /** Shorthand — equivalent to info() */
  (msg: string): void;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Create a structured logger for a module.
 *
 * Usage:
 *   const log = createLogger("brain");
 *   log("hello");          // [2026-03-19T07:34:00Z] [INFO] [brain] hello
 *   log.info("hello");     // same
 *   log.debug("details");  // only shown when LOG_LEVEL=debug
 *   log.warn("careful");   // [WARN] prefix
 *   log.error("broken");   // [ERROR] prefix, uses console.error
 */
export function createLogger(module: string): Logger {
  const fn = ((msg: string) => emit("info", module, msg)) as Logger;
  fn.debug = (msg: string) => emit("debug", module, msg);
  fn.info = (msg: string) => emit("info", module, msg);
  fn.warn = (msg: string) => emit("warn", module, msg);
  fn.error = (msg: string) => emit("error", module, msg);
  return fn;
}
