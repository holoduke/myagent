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

import { eventMatchesDevice, matchesWeatherReflex, findReflex, isOnCooldown, REFLEXES } from "../backend/ha-reflexes.js";
import { withDefaults, DEFAULT_WEATHER_REFLEX } from "../backend/integrations/homeassistant.js";
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

describe("matchesWeatherReflex", () => {
  const cfg = { ...DEFAULT_WEATHER_REFLEX };

  it("fires on configured short presses only", () => {
    expect(matchesWeatherReflex(press(), cfg)).toBe(true);
    expect(matchesWeatherReflex(press({ action: "arrow_left_click" }), cfg)).toBe(true);
    expect(matchesWeatherReflex(press({ action: "brightness_move_up" }), cfg)).toBe(false);
    expect(matchesWeatherReflex(press({ action: undefined }), cfg)).toBe(false);
  });

  it("ignores other devices, other event types and disabled config", () => {
    expect(matchesWeatherReflex(press({ device: "switch ikea 1" }), cfg)).toBe(false);
    expect(matchesWeatherReflex(press({ type: "state_change" }), cfg)).toBe(false);
    expect(matchesWeatherReflex(press(), { ...cfg, enabled: false })).toBe(false);
  });
});

describe("findReflex", () => {
  it("returns the weather reflex for the silver STYRBAR and null otherwise", () => {
    const config = withDefaults(null);
    expect(findReflex(press(), config)?.id).toBe("weather_briefing");
    expect(findReflex(press({ device: "bewegingssensor 1", action: undefined, type: "state_change", state: "on" }), config)).toBeNull();
    expect(REFLEXES.map(r => r.id)).toContain("weather_briefing");
  });
});

describe("isOnCooldown", () => {
  it("is not on cooldown before any run", () => {
    expect(isOnCooldown("weather_briefing", Date.now())).toBe(false);
  });
});
