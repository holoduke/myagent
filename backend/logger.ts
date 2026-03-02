import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";

export function createLogger(module: string) {
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] [${module}] ${msg}`;
    console.log(line);
    try {
      appendFileSync(LOG_FILE, line + "\n");
    } catch { /* prevent disk errors from crashing */ }
  };
}
