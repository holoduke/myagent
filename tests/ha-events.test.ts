import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory file store so buffering never touches /data.
const files = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../backend/utils/file-store.js", () => ({
  FileStore: class<T> {
    constructor(private opts: { filePath: string; defaultValue: T }) {}
    load(): T { return (files.has(this.opts.filePath) ? files.get(this.opts.filePath) : this.opts.defaultValue) as T; }
    save(v: T) { files.set(this.opts.filePath, v); }
    exists() { return files.has(this.opts.filePath); }
  },
  ensureDir: () => {},
  atomicWriteFile: () => {},
  safeReadJSON: <T,>(_p: string, fallback: T) => fallback,
  atomicWriteJSON: () => {},
}));
vi.mock("fs", () => ({
  appendFileSync: () => {},
  existsSync: () => false,
  readFileSync: () => "",
}));

import {
  parseHAEvent,
  parseEventTimestamp,
  describeEvent,
  classifyIntake,
  bufferEvent,
  drainEvents,
  getPendingCount,
  MAX_EVENTS_PER_WINDOW,
  MAX_PENDING_EVENTS,
  BOUNCE_WINDOW_MS,
} from "../backend/integrations/ha-events.js";
import type { HAEvent } from "../backend/integrations/ha-events.js";

beforeEach(() => files.clear());

function event(overrides: Partial<HAEvent> = {}): HAEvent {
  return {
    id: "hae_1",
    receivedAt: 1_000_000,
    ts: 1_000_000,
    type: "button_press",
    device: "Ikea switch 3 silver",
    action: "on",
    ...overrides,
  };
}

describe("parseHAEvent", () => {
  it("accepts a minimal button press and normalizes snake_case keys", () => {
    const r = parseHAEvent({ type: "button_press", device: "Ikea switch 3 silver", action: "on", entity_id: "sensor.x", ts: 1700000000 }, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.device).toBe("Ikea switch 3 silver");
    expect(r.event.entityId).toBe("sensor.x");
    expect(r.event.ts).toBe(1700000000000); // seconds → ms
    expect(r.event.receivedAt).toBe(5);
    expect(r.event.id).toMatch(/^hae_/);
  });

  it("rejects non-objects, missing type, bad type and missing subject", () => {
    expect(parseHAEvent("nope").ok).toBe(false);
    expect(parseHAEvent([]).ok).toBe(false);
    expect(parseHAEvent({ device: "x" }).ok).toBe(false);
    expect(parseHAEvent({ type: "bad type!", device: "x" }).ok).toBe(false);
    expect(parseHAEvent({ type: "button_press" }).ok).toBe(false);
  });

  it("rejects oversized strings and nested payloads", () => {
    expect(parseHAEvent({ type: "x", device: "a".repeat(201) }).ok).toBe(false);
    expect(parseHAEvent({ type: "x", device: "a", attributes: { blob: "b".repeat(9000) } }).ok).toBe(false);
    expect(parseHAEvent({ type: "x", device: "a", context: [] }).ok).toBe(false);
  });

  it("keeps a forecast passed in context", () => {
    const r = parseHAEvent({ type: "button_press", device: "a", context: { forecast: [{ datetime: "2026-09-04T00:00:00+02:00" }] } });
    expect(r.ok && Array.isArray(r.event.context?.forecast)).toBe(true);
  });
});

describe("parseEventTimestamp", () => {
  it("handles ms, seconds, ISO and garbage", () => {
    expect(parseEventTimestamp(1700000000000, 1)).toBe(1700000000000);
    expect(parseEventTimestamp(1700000000, 1)).toBe(1700000000000);
    expect(parseEventTimestamp("2026-09-04T10:00:00Z", 1)).toBe(Date.parse("2026-09-04T10:00:00Z"));
    expect(parseEventTimestamp("not a date", 1)).toBe(1);
    expect(parseEventTimestamp(undefined, 1)).toBe(1);
  });
});

describe("describeEvent", () => {
  it("describes presses and state changes", () => {
    expect(describeEvent(event())).toBe("Ikea switch 3 silver: on");
    expect(describeEvent(event({ type: "state_change", action: undefined, entityId: "light.keuken", friendlyName: "Keuken", state: "on", previousState: "off" })))
      .toBe("Keuken: off → on");
  });
});

describe("classifyIntake", () => {
  it("accepts a fresh event", () => {
    expect(classifyIntake(event(), { events: [], windowTimestamps: [] })).toBe("accepted");
  });

  it("drops an identical event inside the bounce window", () => {
    const first = event();
    const second = event({ receivedAt: first.receivedAt + BOUNCE_WINDOW_MS - 1 });
    expect(classifyIntake(second, { events: [first], windowTimestamps: [first.receivedAt] })).toBe("bounce");
    const later = event({ receivedAt: first.receivedAt + BOUNCE_WINDOW_MS + 1 });
    expect(classifyIntake(later, { events: [first], windowTimestamps: [first.receivedAt] })).toBe("accepted");
  });

  it("does not treat a different action as a bounce", () => {
    const first = event();
    const other = event({ action: "off", receivedAt: first.receivedAt + 100 });
    expect(classifyIntake(other, { events: [first], windowTimestamps: [first.receivedAt] })).toBe("accepted");
  });

  it("flood-guards after the per-window cap", () => {
    const stamps = Array.from({ length: MAX_EVENTS_PER_WINDOW }, (_, i) => 1_000_000 - i * 10);
    expect(classifyIntake(event({ receivedAt: 1_000_100, action: "off" }), { events: [], windowTimestamps: stamps })).toBe("flood");
  });

  it("reports overflow when the pending buffer is full", () => {
    const events = Array.from({ length: MAX_PENDING_EVENTS }, (_, i) => event({ id: `e${i}`, receivedAt: i * 5000, action: "off" }));
    expect(classifyIntake(event({ receivedAt: 99_999_999 }), { events, windowTimestamps: [] })).toBe("overflow");
  });
});

describe("bufferEvent / drainEvents", () => {
  it("buffers accepted events with reflex outcome and drains them", () => {
    expect(bufferEvent(event(), { by: "weather_briefing", summary: "spoke" })).toBe("accepted");
    expect(bufferEvent(event({ id: "hae_2", receivedAt: 1_010_000, action: "off" }))).toBe("accepted");
    expect(getPendingCount()).toBe(2);
    const drained = drainEvents(2_000_000);
    expect(drained.events.map(e => e.id)).toEqual(["hae_1", "hae_2"]);
    expect(drained.events[0].handledBy).toBe("weather_briefing");
    expect(drained.dropped).toBe(0);
    expect(getPendingCount()).toBe(0);
  });

  it("counts dropped bounces for the next digest", () => {
    bufferEvent(event());
    expect(bufferEvent(event({ id: "hae_dup", receivedAt: 1_000_500 }))).toBe("bounce");
    expect(drainEvents().dropped).toBe(1);
  });
});
