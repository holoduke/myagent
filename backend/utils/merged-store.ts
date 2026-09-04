/**
 * MergedStore<T> — a cached JSON file store that survives two instances
 * sharing the same /data volume (container restarts overlap for 1-3 minutes).
 *
 * A plain write-through cache does last-writer-wins: instance B's stale cache
 * silently reverts whatever instance A wrote. This store records the file's
 * mtime/size at load time and, before every write, checks whether the file
 * changed underneath it. If it did, the on-disk state is re-read and the
 * caller's change is applied on top of the fresh state (`update`) or merged
 * with it via a caller-supplied merge function (`saveMerged`).
 *
 * Only `safeReadJSON` / `atomicWriteJSON` / `ensureDir` from file-store are
 * used, so unit tests that mock that module keep working.
 */

import { statSync } from "fs";
import { dirname } from "path";
import { safeReadJSON, atomicWriteJSON, ensureDir } from "./file-store.js";

export interface MergedStoreOptions<T> {
  filePath: string;
  defaultValue: () => T;
  indent?: number;
}

interface FileStamp {
  mtimeMs: number;
  size: number;
}

const NO_FILE: FileStamp = { mtimeMs: 0, size: -1 };

function stampOf(filePath: string): FileStamp {
  try {
    const st = statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return NO_FILE;
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export class MergedStore<T> {
  private readonly filePath: string;
  private readonly defaultValue: () => T;
  private readonly indent: number;
  private cache: T | null = null;
  private loadedStamp: FileStamp = NO_FILE;

  constructor(opts: MergedStoreOptions<T>) {
    this.filePath = opts.filePath;
    this.defaultValue = opts.defaultValue;
    this.indent = opts.indent ?? 2;
  }

  get path(): string {
    return this.filePath;
  }

  /** True when the file on disk changed since the cache was (re)loaded. */
  changedOnDisk(): boolean {
    return this.cache !== null && !sameStamp(stampOf(this.filePath), this.loadedStamp);
  }

  /** Cached value; re-reads from disk when the file changed since last load. */
  get(): T {
    if (this.cache === null || this.changedOnDisk()) {
      this.reload();
    }
    return this.cache as T;
  }

  /** Cached value without touching the disk (null when never loaded). */
  peek(): T | null {
    return this.cache;
  }

  /** Force a re-read from disk on next access. */
  invalidate(): void {
    this.cache = null;
    this.loadedStamp = NO_FILE;
  }

  /**
   * Apply a change on top of the freshest on-disk state and persist it.
   * `fn` must not mutate its argument — return a new value.
   */
  update(fn: (current: T) => T): T {
    const next = fn(this.get());
    this.write(next);
    return next;
  }

  /**
   * Persist an in-memory value that may have diverged from disk. When the
   * file changed underneath us, `merge(disk, memory)` decides the outcome.
   */
  saveMerged(memory: T, merge: (disk: T, memory: T) => T): T {
    const next = this.changedOnDisk() ? merge(this.readDisk(), memory) : memory;
    this.write(next);
    return next;
  }

  private reload(): void {
    this.cache = this.readDisk();
  }

  private readDisk(): T {
    const stamp = stampOf(this.filePath);
    const value = safeReadJSON<T>(this.filePath, this.defaultValue());
    this.loadedStamp = stamp;
    return value;
  }

  private write(value: T): void {
    ensureDir(dirname(this.filePath));
    atomicWriteJSON(this.filePath, value, this.indent);
    this.cache = value;
    this.loadedStamp = stampOf(this.filePath);
  }
}
