/**
 * Outbound buffer — holds owner-bound messages while the WhatsApp socket is
 * down and flushes them in order once the connection reopens.
 *
 * Bounded (default 20 entries) with a TTL (default 10 min): when full, the
 * oldest entry is dropped; expired entries are discarded at drain time.
 * The buffer is immutable-by-construction: every mutation replaces the
 * internal array rather than editing it in place.
 */

export const OUTBOUND_BUFFER_CAP = 20;
export const OUTBOUND_BUFFER_TTL_MS = 10 * 60 * 1000;

export interface OutboundEntry {
  jid: string;
  text: string;
  source: string;
  queuedAt: number;
}

export interface PushResult {
  /** Entry evicted to make room, if any. */
  dropped: OutboundEntry | null;
}

export interface DrainResult {
  ready: OutboundEntry[];
  expired: OutboundEntry[];
}

/** Pure: append an entry, evicting the oldest when over capacity. */
export function pushEntry(
  entries: readonly OutboundEntry[],
  entry: OutboundEntry,
  cap: number = OUTBOUND_BUFFER_CAP,
): { entries: OutboundEntry[]; dropped: OutboundEntry | null } {
  const next = [...entries, entry];
  if (next.length <= cap) return { entries: next, dropped: null };
  return { entries: next.slice(next.length - cap), dropped: next[0] };
}

/** Pure: split entries into still-fresh and expired, preserving order. */
export function partitionExpired(
  entries: readonly OutboundEntry[],
  now: number,
  ttlMs: number = OUTBOUND_BUFFER_TTL_MS,
): DrainResult {
  return {
    ready: entries.filter((e) => now - e.queuedAt <= ttlMs),
    expired: entries.filter((e) => now - e.queuedAt > ttlMs),
  };
}

export class OutboundBuffer {
  private entries: readonly OutboundEntry[] = [];
  private readonly cap: number;
  private readonly ttlMs: number;

  constructor(cap: number = OUTBOUND_BUFFER_CAP, ttlMs: number = OUTBOUND_BUFFER_TTL_MS) {
    this.cap = cap;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.entries.length;
  }

  push(entry: OutboundEntry): PushResult {
    const result = pushEntry(this.entries, entry, this.cap);
    this.entries = result.entries;
    return { dropped: result.dropped };
  }

  /** Remove and return everything; fresh entries first, expired listed separately. */
  drain(now: number = Date.now()): DrainResult {
    const result = partitionExpired(this.entries, now, this.ttlMs);
    this.entries = [];
    return result;
  }
}
