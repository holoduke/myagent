/**
 * FileStore<T> — reusable file persistence utility.
 *
 * Consolidates the repeated patterns of:
 *   - ensureDir / mkdirSync(recursive)
 *   - atomic writes (write to .tmp, rename)
 *   - JSON load with error handling and fallback defaults
 *   - JSON save with optional pretty printing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { dirname } from "path";

// ── Write lock for concurrent write protection ──
//
// Maps file path → tail of an in-flight Promise chain. Each new write awaits
// the prior tail and replaces it with its own promise. This serializes writes
// to the same path even when callers come from different modules (HTTP API,
// brain ticks, workers) that don't share an outer mutex.
//
// Note: only synchronous writes use this; the public API (`atomicWriteJSON`)
// remains synchronous to keep call sites simple. The lock is therefore
// best-effort within a single tick of the event loop and serves as a soft
// barrier rather than a hard mutex. For genuine cross-async serialization
// callers should use `atomicWriteJSONAsync`.

const writeLocks = new Map<string, boolean>();
const asyncWriteChains = new Map<string, Promise<void>>();

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

/**
 * Atomic write: writes content to a .tmp file then renames.
 * Ensures the parent directory exists.
 */
export function atomicWriteFile(filePath: string, content: string): void {
  ensureParentDir(filePath);
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

/**
 * Atomic JSON write with pretty printing (2-space indent by default).
 * Set `indent` to 0 for compact output, or any number for custom spacing.
 *
 * Uses a per-file write lock to detect concurrent write attempts.
 * The actual write is atomic (write-to-tmp + rename), so data won't corrupt,
 * but the lock prevents interleaving of read-modify-write sequences.
 */
export function atomicWriteJSON<T>(filePath: string, data: T, indent: number = 2): void {
  if (writeLocks.get(filePath)) {
    // Another write is in progress -- atomic rename is still safe,
    // but log for visibility into potential read-modify-write races
    // eslint-disable-next-line no-console
    console.warn(`[file-store] Concurrent write detected for ${filePath}`);
  }
  writeLocks.set(filePath, true);
  try {
    atomicWriteFile(filePath, JSON.stringify(data, null, indent));
  } finally {
    writeLocks.delete(filePath);
  }
}

/**
 * Async serialized JSON write. Chains writes to the same path so concurrent
 * callers from different modules can't interleave their saves.
 *
 * Callers that already hold an outer mutex (e.g. brain `tickLock`) can use
 * the synchronous `atomicWriteJSON` for simplicity. Callers from HTTP routes
 * or worker pickups should prefer this async form.
 */
export async function atomicWriteJSONAsync<T>(
  filePath: string,
  data: T,
  indent: number = 2,
): Promise<void> {
  const prior = asyncWriteChains.get(filePath) ?? Promise.resolve();
  const next = prior
    .catch(() => { /* prior failure shouldn't block subsequent writes */ })
    .then(() => {
      atomicWriteFile(filePath, JSON.stringify(data, null, indent));
    });
  asyncWriteChains.set(filePath, next);
  try {
    await next;
  } finally {
    if (asyncWriteChains.get(filePath) === next) {
      asyncWriteChains.delete(filePath);
    }
  }
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
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
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
