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
 */
export function atomicWriteJSON<T>(filePath: string, data: T, indent: number = 2): void {
  atomicWriteFile(filePath, JSON.stringify(data, null, indent));
}

/**
 * Safe JSON read with a fallback value.
 * Returns the fallback on missing file, parse error, or any other read error.
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
