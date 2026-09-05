/**
 * FileStore<T> — reusable file persistence utility.
 *
 * Consolidates the repeated patterns of:
 *   - ensureDir / mkdirSync(recursive)
 *   - atomic, durable writes (unique tmp → fsync → rename → dir fsync)
 *   - JSON load with error handling and fallback defaults
 *   - JSON save with optional pretty printing
 *   - rolling JSONL logs (append, then trim to the last N entries)
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  appendFileSync,
} from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

// ── Standalone utility functions ──

/** Ensure a directory exists (creates recursively if needed). */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** Ensure the parent directory of a file path exists. */
export function ensureParentDir(filePath: string): void {
  ensureDir(dirname(filePath));
}

/** Unique temp path next to the target so the final rename stays on one filesystem. */
export function uniqueTmpPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/** fsync a directory so a just-renamed entry survives a crash. Best-effort. */
function fsyncDir(dirPath: string): void {
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems — durability
    // of the rename is then only as good as the OS guarantees. Non-fatal.
  }
}

/**
 * Atomic, durable write: content goes to a unique temp file (pid + random so
 * two processes sharing the directory never clobber each other's temp file),
 * is fsynced, then renamed over the target. Ensures the parent directory exists.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  ensureParentDir(filePath);
  const tmp = uniqueTmpPath(filePath);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* temp already gone */ }
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, filePath);
  fsyncDir(dirname(filePath));
}

/**
 * Atomic JSON write with pretty printing (2-space indent by default).
 * Set `indent` to 0 for compact output, or any number for custom spacing.
 */
export function atomicWriteJSON<T>(filePath: string, data: T, indent: number = 2): void {
  atomicWriteFile(filePath, JSON.stringify(data, null, indent));
}

/**
 * Strict JSON read — throws on parse error.
 * Use this for files where silent fallback to defaults would mask data loss
 * (the memory graph in particular). Returns null only for missing files.
 */
export function strictReadJSON<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Safe JSON read with a fallback value.
 * Returns the fallback on missing file, parse error, or any other read error.
 *
 * WARNING: silently returns the fallback on parse errors. This is appropriate
 * for ephemeral state (e.g., daily counters) but NOT for canonical data like
 * the memory graph — silent corruption recovery there equals amnesia. Use
 * `strictReadJSON` for canonical data and handle the error explicitly.
 */
export function safeReadJSON<T>(filePath: string, fallback: T): T {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    }
  } catch {
    // Corrupted or unreadable — fall back silently
  }
  return fallback;
}

// ── Rolling JSONL ──

/**
 * Append one JSON entry to a JSONL log and trim it to the last `maxEntries`
 * lines. The trim is an atomic rewrite, so a crash mid-trim never truncates
 * the log to garbage. Throws on I/O failure — callers decide how loud to be.
 */
export function appendRollingJsonl<T>(filePath: string, entry: T, maxEntries: number): void {
  ensureParentDir(filePath);
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  if (lines.length > maxEntries) {
    atomicWriteFile(filePath, lines.slice(lines.length - maxEntries).join("\n") + "\n");
  }
}

/** Read and parse a JSONL file; malformed lines are skipped (count returned). */
export function readJsonl<T>(filePath: string): { entries: T[]; malformed: number } {
  if (!existsSync(filePath)) return { entries: [], malformed: 0 };
  const entries: T[] = [];
  let malformed = 0;
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as T);
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

// ── FileStore class ──

export interface FileStoreOptions<T> {
  /** Absolute path to the JSON file. */
  filePath: string;
  /** Default value returned when the file doesn't exist or is corrupt. */
  defaultValue: T;
  /**
   * JSON indentation (number of spaces). Default: 2.
   * Set to 0 for compact (no whitespace) output.
   */
  indent?: number;
}

/**
 * Generic JSON file store with atomic writes and safe reads.
 *
 * Usage:
 *   const store = new FileStore({ filePath: "/data/brain/config.json", defaultValue: {} });
 *   const data = store.load();
 *   store.save(updatedData);
 */
export class FileStore<T> {
  private readonly filePath: string;
  private readonly defaultValue: T;
  private readonly indent: number;

  constructor(opts: FileStoreOptions<T>) {
    this.filePath = opts.filePath;
    this.defaultValue = opts.defaultValue;
    this.indent = opts.indent ?? 2;
  }

  /** Load and parse the JSON file. Returns defaultValue on any error. */
  load(): T {
    return safeReadJSON(this.filePath, this.defaultValue);
  }

  /** Atomically save data as JSON. */
  save(data: T): void {
    atomicWriteJSON(this.filePath, data, this.indent);
  }

  /** Check whether the backing file exists. */
  exists(): boolean {
    return existsSync(this.filePath);
  }

  /** Get the file path this store manages. */
  get path(): string {
    return this.filePath;
  }
}
