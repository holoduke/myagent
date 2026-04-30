import { atomicWriteJSON } from "./file-store.js";

/**
 * A bounded set that tracks seen IDs and evicts the oldest entries
 * when the capacity is exceeded. Serializable to/from a JSON array.
 */
export class DedupCache {
  private seen = new Set<string>();
  private maxSize: number;
  private evictBatch: number;

  constructor(maxSize = 200, evictBatch = 50) {
    this.maxSize = maxSize;
    this.evictBatch = evictBatch;
  }

  /** Load entries from a persisted array. */
  load(ids: string[]): void {
    this.seen.clear();
    for (const id of ids) this.seen.add(id);
  }

  /** Returns false if already seen, true if new (and adds it). */
  track(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.maxSize) {
      const iter = this.seen.values();
      for (let i = 0; i < this.evictBatch; i++) {
        const val = iter.next().value;
        if (val) this.seen.delete(val);
      }
    }
    return true;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  get size(): number {
    return this.seen.size;
  }

  /** Export for persistence (trimmed to maxSize). */
  toArray(): string[] {
    const all = Array.from(this.seen);
    return all.length > this.maxSize ? all.slice(all.length - this.maxSize) : all;
  }

  /** Persist to a JSON file. */
  saveTo(filePath: string): void {
    atomicWriteJSON(filePath, this.toArray(), 0);
  }
}
