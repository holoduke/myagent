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

import { withDefaults, isMeaningfulStateChange, getActiveConnection, DEFAULT_WEATHER_REFLEX, DEFAULT_MIND_REFLEX, DEFAULT_SPEECH } from "../backend/integrations/homeassistant.js";
import type { HAConfig } from "../backend/integrations/homeassistant.js";

describe("withDefaults", () => {
  it("produces a webhook-only config with polling off when nothing is saved", () => {
    const cfg = withDefaults(null);
    expect(cfg.mode).toBe("webhook");
    expect(cfg.entities).toEqual([]);
    expect(cfg.speech).toEqual(DEFAULT_SPEECH);
    expect(cfg.reflexes.weatherBriefing).toEqual(DEFAULT_WEATHER_REFLEX);
    expect(cfg.reflexes.mindBriefing).toEqual(DEFAULT_MIND_REFLEX);
    expect(cfg.digestIntervalMs).toBe(15 * 60 * 1000);
    expect(getActiveConnection(cfg)).toBeNull();
  });

  it("migrates speech settings that older files kept inside the weather reflex", () => {
    const legacy = {
      reflexes: {
        weatherBriefing: { ...DEFAULT_WEATHER_REFLEX, actions: ["on"], mediaPlayer: "media_player.keuken", ttsEngine: "tts.edge", language: "nl-NL-FennaNeural", ttsVolume: 0.5 },
      },
    } as unknown as Partial<HAConfig>;
    const cfg = withDefaults(legacy);
    expect(cfg.speech).toEqual({ mediaPlayer: "media_player.keuken", ttsEngine: "tts.edge", language: "nl-NL-FennaNeural", ttsVolume: 0.5 });
    expect(cfg.reflexes.weatherBriefing.actions).toEqual(["on"]);
    expect("mediaPlayer" in cfg.reflexes.weatherBriefing).toBe(false);
    expect(cfg.reflexes.mindBriefing).toEqual(DEFAULT_MIND_REFLEX);
  });

  it("keeps an explicit empty entity list (polling off) and clamps numbers", () => {
    const cfg = withDefaults({ entities: [], pollInterval: 1, digestIntervalMs: 1, speech: { ...DEFAULT_SPEECH, ttsVolume: 3 }, reflexes: { weatherBriefing: { ...DEFAULT_WEATHER_REFLEX, eveningHour: 99 }, mindBriefing: DEFAULT_MIND_REFLEX } });
    expect(cfg.entities).toEqual([]);
    expect(cfg.pollInterval).toBe(15_000);
    expect(cfg.digestIntervalMs).toBe(60_000);
    expect(cfg.reflexes.weatherBriefing.eveningHour).toBe(23);
    expect(cfg.speech.ttsVolume).toBe(1);
  });

  it("preserves a null ttsVolume and a direct connection", () => {
    const cfg = withDefaults({ mode: "direct_api", direct_api: { url: "http://1.2.3.4:8123/", token: "t" }, speech: { ...DEFAULT_SPEECH, ttsVolume: null } });
    expect(cfg.speech.ttsVolume).toBeNull();
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
