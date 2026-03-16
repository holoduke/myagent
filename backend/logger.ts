import { appendFileSync, statSync, renameSync, unlinkSync, existsSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 5;

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

export function createLogger(module: string) {
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] [${module}] ${msg}`;
    console.log(line);
    try {
      rotateIfNeeded();
      appendFileSync(LOG_FILE, line + "\n");
    } catch { /* prevent disk errors from crashing */ }
  };
}
