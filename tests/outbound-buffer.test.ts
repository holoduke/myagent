import { describe, it, expect } from "vitest";
import {
  pushEntry,
  partitionExpired,
  OutboundBuffer,
  OUTBOUND_BUFFER_CAP,
  OUTBOUND_BUFFER_TTL_MS,
  type OutboundEntry,
} from "../backend/integrations/outbound-buffer.js";

const entry = (text: string, queuedAt: number): OutboundEntry =>
  ({ jid: "owner@s.whatsapp.net", text, source: "chat", queuedAt });

describe("pushEntry", () => {
  it("appends without mutating the input", () => {
    const before = [entry("a", 1)];
    const { entries, dropped } = pushEntry(before, entry("b", 2));
    expect(before).toHaveLength(1);
    expect(entries.map((e) => e.text)).toEqual(["a", "b"]);
    expect(dropped).toBeNull();
  });

  it("evicts the oldest when over capacity", () => {
    const full = Array.from({ length: 3 }, (_, i) => entry(`m${i}`, i));
    const { entries, dropped } = pushEntry(full, entry("new", 9), 3);
    expect(dropped?.text).toBe("m0");
    expect(entries.map((e) => e.text)).toEqual(["m1", "m2", "new"]);
  });
});

describe("partitionExpired", () => {
  it("splits by TTL preserving order", () => {
    const now = 100_000;
    const list = [entry("expired", now - OUTBOUND_BUFFER_TTL_MS - 1), entry("edge", now - OUTBOUND_BUFFER_TTL_MS), entry("fresh", now)];
    const { ready, expired } = partitionExpired(list, now);
    expect(ready.map((e) => e.text)).toEqual(["edge", "fresh"]);
    expect(expired.map((e) => e.text)).toEqual(["expired"]);
  });
});

describe("OutboundBuffer", () => {
  it("defaults to cap 20 and drains in FIFO order, then is empty", () => {
    const buf = new OutboundBuffer();
    for (let i = 0; i < OUTBOUND_BUFFER_CAP + 5; i++) buf.push(entry(`m${i}`, 1_000 + i));
    expect(buf.size).toBe(OUTBOUND_BUFFER_CAP);

    const { ready, expired } = buf.drain(2_000);
    expect(ready[0].text).toBe("m5");
    expect(ready[ready.length - 1].text).toBe(`m${OUTBOUND_BUFFER_CAP + 4}`);
    expect(expired).toEqual([]);
    expect(buf.size).toBe(0);
  });

  it("reports expired entries separately", () => {
    const buf = new OutboundBuffer(5, 1_000);
    buf.push(entry("old", 0));
    buf.push(entry("new", 900));
    const { ready, expired } = buf.drain(1_500);
    expect(ready.map((e) => e.text)).toEqual(["new"]);
    expect(expired.map((e) => e.text)).toEqual(["old"]);
  });
});
