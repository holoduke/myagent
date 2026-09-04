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

import { withDefaults, isMeaningfulStateChange, getActiveConnection, DEFAULT_WEATHER_REFLEX } from "../backend/integrations/homeassistant.js";

describe("withDefaults", () => {
  it("produces a webhook-only config with polling off when nothing is saved", () => {
    const cfg = withDefaults(null);
    expect(cfg.mode).toBe("webhook");
    expect(cfg.entities).toEqual([]);
    expect(cfg.reflexes.weatherBriefing).toEqual(DEFAULT_WEATHER_REFLEX);
    expect(cfg.digestIntervalMs).toBe(15 * 60 * 1000);
    expect(getActiveConnection(cfg)).toBeNull();
  });

  it("keeps an explicit empty entity list (polling off) and clamps numbers", () => {
    const cfg = withDefaults({ entities: [], pollInterval: 1, digestIntervalMs: 1, reflexes: { weatherBriefing: { ...DEFAULT_WEATHER_REFLEX, eveningHour: 99, ttsVolume: 3 } } });
    expect(cfg.entities).toEqual([]);
    expect(cfg.pollInterval).toBe(15_000);
    expect(cfg.digestIntervalMs).toBe(60_000);
    expect(cfg.reflexes.weatherBriefing.eveningHour).toBe(23);
    expect(cfg.reflexes.weatherBriefing.ttsVolume).toBe(1);
  });

  it("preserves a null ttsVolume and a direct connection", () => {
    const cfg = withDefaults({ mode: "direct_api", direct_api: { url: "http://1.2.3.4:8123/", token: "t" }, reflexes: { weatherBriefing: { ...DEFAULT_WEATHER_REFLEX, ttsVolume: null } } });
    expect(cfg.reflexes.weatherBriefing.ttsVolume).toBeNull();
    expect(getActiveConnection(cfg)).toEqual({ url: "http://1.2.3.4:8123", token: "t" });
  });
});

describe("isMeaningfulStateChange", () => {
  it("ignores first sight, no-ops and unknown/unavailable flaps", () => {
    expect(isMeaningfulStateChange(undefined, "on")).toBe(false);
    expect(isMeaningfulStateChange("on", "on")).toBe(false);
    expect(isMeaningfulStateChange("on", "unknown")).toBe(false);
    expect(isMeaningfulStateChange("unavailable", "on")).toBe(false);
  });

  it("keeps real transitions", () => {
    expect(isMeaningfulStateChange("off", "on")).toBe(true);
    expect(isMeaningfulStateChange("21.5", "22.0")).toBe(true);
  });
});
