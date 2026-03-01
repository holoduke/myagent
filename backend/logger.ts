import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";

/**
 * Create a namespaced log function for a module.
 * Usage: const log = createLogger("my-module");
 */
export function createLogger(module: string): (msg: string) => void {
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] [${module}] ${msg}`;
    console.log(line);
    try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
  };
}
