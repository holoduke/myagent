import { describe, it, expect, vi } from "vitest";

vi.mock("../backend/utils/file-store.js", () => ({
  FileStore: class<T> {
    constructor(private opts: { filePath: string; defaultValue: T }) {}
    load(): T { return this.opts.defaultValue; }
    save() {}
    exists() { return false; }
  },
  ensureDir: () => {},
  atomicWriteFile: () => {},
  safeReadJSON: <T,>(_p: string, fallback: T) => fallback,
  atomicWriteJSON: () => {},
}));

import { eventMatchesDevice, matchesButtonRule, findReflex, isOnCooldown, REFLEXES } from "../backend/ha-reflexes.js";
import { withDefaults, DEFAULT_WEATHER_REFLEX, DEFAULT_MIND_REFLEX } from "../backend/integrations/homeassistant.js";
import type { HAEvent } from "../backend/integrations/ha-events.js";

function press(overrides: Partial<HAEvent> = {}): HAEvent {
  return { id: "e", receivedAt: 0, ts: 0, type: "button_press", device: "Ikea switch 3 silver", action: "on", ...overrides };
}

describe("eventMatchesDevice", () => {
  it("matches device, friendly name or entity id, ignoring case and separators", () => {
    expect(eventMatchesDevice(press(), "ikea switch 3 silver")).toBe(true);
    expect(eventMatchesDevice(press({ device: undefined, friendlyName: "Ikea_Switch-3 Silver" }), "Ikea switch 3 silver")).toBe(true);
    expect(eventMatchesDevice(press({ device: undefined, entityId: "sensor.ikea_switch_3_silver_action" }), "sensor.ikea_switch_3_silver_action")).toBe(true);
    expect(eventMatchesDevice(press({ device: "switch ikea 1" }), "Ikea switch 3 silver")).toBe(false);
    expect(eventMatchesDevice(press(), "")).toBe(false);
  });
});

describe("matchesButtonRule", () => {
  it("fires on configured actions only", () => {
    expect(matchesButtonRule(press(), DEFAULT_WEATHER_REFLEX)).toBe(true);
    expect(matchesButtonRule(press({ action: "arrow_left_click" }), DEFAULT_WEATHER_REFLEX)).toBe(true);
    expect(matchesButtonRule(press({ action: "arrow_right_click" }), DEFAULT_WEATHER_REFLEX)).toBe(false);
    expect(matchesButtonRule(press({ action: "arrow_right_click" }), DEFAULT_MIND_REFLEX)).toBe(true);
    expect(matchesButtonRule(press({ action: "brightness_move_up" }), DEFAULT_WEATHER_REFLEX)).toBe(false);
    expect(matchesButtonRule(press({ action: undefined }), DEFAULT_WEATHER_REFLEX)).toBe(false);
  });

  it("ignores other devices, other event types and disabled rules", () => {
    expect(matchesButtonRule(press({ device: "switch ikea 1" }), DEFAULT_WEATHER_REFLEX)).toBe(false);
    expect(matchesButtonRule(press({ type: "state_change" }), DEFAULT_WEATHER_REFLEX)).toBe(false);
    expect(matchesButtonRule(press(), { ...DEFAULT_WEATHER_REFLEX, enabled: false })).toBe(false);
  });
});

describe("findReflex", () => {
  it("routes the silver STYRBAR buttons to weather or mind, and nothing else", () => {
    const config = withDefaults(null);
    expect(findReflex(press(), config)?.id).toBe("weather_briefing");
    expect(findReflex(press({ action: "arrow_right_click" }), config)?.id).toBe("mind_briefing");
    expect(findReflex(press({ device: "bewegingssensor 1", action: undefined, type: "state_change", state: "on" }), config)).toBeNull();
    expect(REFLEXES.map(r => r.id)).toEqual(["weather_briefing", "mind_briefing"]);
  });
});

describe("isOnCooldown", () => {
  it("is not on cooldown before any run", () => {
    expect(isOnCooldown("weather_briefing", Date.now())).toBe(false);
  });
});
