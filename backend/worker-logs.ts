import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync } from "fs";
import { createLogger } from "./logger.js";

const log = createLogger("worker-logs");

const WORKER_LOGS_DIR = "/data/brain/worker-logs";
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_LOGS = 50;

export function ensureLogDir(): void {
  if (!existsSync(WORKER_LOGS_DIR)) {
    mkdirSync(WORKER_LOGS_DIR, { recursive: true });
  }
}

export function workerLogPath(workerId: string): string {
  ensureLogDir();
  // Sanitize workerId to prevent path traversal
  const safe = workerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${WORKER_LOGS_DIR}/${safe}.log`;
}

/** Open a file descriptor for writing worker output. Returns the fd for use with stdio. */
export function openWorkerLog(workerId: string): number {
  const path = workerLogPath(workerId);
  return openSync(path, "a");
}

/** List all worker logs with metadata */
export function listWorkerLogs(): Array<{ id: string; path: string; size: number; createdAt: number; modifiedAt: number }> {
  ensureLogDir();
  try {
    const files = readdirSync(WORKER_LOGS_DIR).filter(f => f.endsWith(".log"));
    return files.map(f => {
      const fullPath = `${WORKER_LOGS_DIR}/${f}`;
      const stats = statSync(fullPath);
      return {
        id: f.replace(/\.log$/, ""),
        path: fullPath,
        size: stats.size,
        createdAt: stats.birthtimeMs,
        modifiedAt: stats.mtimeMs,
      };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

/** Clean up old logs */
export function pruneWorkerLogs(): void {
  const logs = listWorkerLogs();
  const now = Date.now();

  for (const logEntry of logs) {
    const age = now - logEntry.modifiedAt;
    if (age > MAX_LOG_AGE_MS) {
      try { unlinkSync(logEntry.path); log(`Pruned old worker log: ${logEntry.id}`); } catch { /* ignore */ }
    }
  }

  // Also prune if too many logs
  const remaining = listWorkerLogs();
  if (remaining.length > MAX_LOGS) {
    for (const logEntry of remaining.slice(MAX_LOGS)) {
      try { unlinkSync(logEntry.path); } catch { /* ignore */ }
    }
  }
}

export { WORKER_LOGS_DIR };
