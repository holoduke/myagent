import { describe, it, expect, vi } from "vitest";

// UTC-based owner-local helpers so day selection is deterministic.
vi.mock("../backend/brain-config.js", () => ({
  getBrainConfig: () => ({ ownerTimezone: "UTC", models: {} }),
  getOwnerLocalTime: (_tz: string, now: Date = new Date()) => ({ hour: now.getUTCHours(), dayOfWeek: now.getUTCDay() }),
  getOwnerLocalDate: (_tz: string, now: Date = new Date()) => now.toISOString().slice(0, 10),
}));

import {
  normalizeHAForecast,
  normalizeOpenMeteo,
  wmoToCondition,
  chooseBriefingDay,
  buildBriefingTemplate,
  buildBriefingPrompt,
  sanitizeSpokenText,
  composeWeatherBriefing,
  fetchOpenMeteoForecast,
} from "../backend/ha-weather.js";
import type { DayForecast } from "../backend/ha-weather.js";

const TZ = "UTC";

const haForecast = [
  { datetime: "2026-09-04T00:00:00+00:00", condition: "pouring", precipitation_probability: 90, temperature: 21, templow: 17, wind_speed: 0.9, precipitation: 4 },
  { datetime: "2026-09-05T00:00:00+00:00", condition: "partlycloudy", precipitation_probability: 30, temperature: 20, templow: 15, wind_speed: 45 },
];

describe("normalizeHAForecast", () => {
  it("maps Home Assistant daily entries and skips junk", () => {
    const days = normalizeHAForecast([...haForecast, { nope: true }, "x"], TZ);
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ date: "2026-09-04", condition: "pouring", tempMax: 21, tempMin: 17, precipitationProbability: 90, precipitation: 4 });
    expect(days[1].precipitation).toBeNull();
  });

  it("returns [] for non-arrays", () => {
    expect(normalizeHAForecast(undefined, TZ)).toEqual([]);
    expect(normalizeHAForecast({}, TZ)).toEqual([]);
  });
});

describe("Open-Meteo mapping", () => {
  it("maps WMO codes to Home Assistant conditions", () => {
    expect(wmoToCondition(0)).toBe("sunny");
    expect(wmoToCondition(2)).toBe("partlycloudy");
    expect(wmoToCondition(3)).toBe("cloudy");
    expect(wmoToCondition(61)).toBe("rainy");
    expect(wmoToCondition(65)).toBe("pouring");
    expect(wmoToCondition(71)).toBe("snowy");
    expect(wmoToCondition(95)).toBe("lightning-rainy");
    expect(wmoToCondition(999)).toBe("unknown");
  });

  it("normalizes the daily block", () => {
    const days = normalizeOpenMeteo({ daily: { time: ["2026-09-04", "2026-09-05"], weather_code: [3, 0], temperature_2m_max: [20, 22], temperature_2m_min: [12, 13], precipitation_sum: [0.4, 0], precipitation_probability_max: [40, 5], wind_speed_10m_max: [20, 15] } });
    expect(days).toHaveLength(2);
    expect(days[1]).toMatchObject({ date: "2026-09-05", condition: "sunny", tempMax: 22, precipitationProbability: 5 });
    expect(normalizeOpenMeteo(null)).toEqual([]);
  });

  it("fetches with the configured location and timezone", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ daily: { time: ["2026-09-04"], weather_code: [0], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_sum: [0], precipitation_probability_max: [0], wind_speed_10m_max: [10] } }) });
    const days = await fetchOpenMeteoForecast({ lat: 52.19, lon: 4.49 }, "Europe/Amsterdam", fetchFn as unknown as typeof fetch);
    expect(days[0].date).toBe("2026-09-04");
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain("latitude=52.19");
    expect(url).toContain("timezone=Europe%2FAmsterdam");
  });

  it("throws on a non-OK response", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchOpenMeteoForecast({ lat: 0, lon: 0 }, TZ, fetchFn as unknown as typeof fetch)).rejects.toThrow("503");
  });
});

describe("chooseBriefingDay", () => {
  it("picks today before the evening hour and tomorrow after", () => {
    expect(chooseBriefingDay(new Date("2026-09-04T08:00:00Z"), TZ, 14)).toEqual({ label: "vandaag", date: "2026-09-04" });
    expect(chooseBriefingDay(new Date("2026-09-04T14:00:00Z"), TZ, 14)).toEqual({ label: "morgen", date: "2026-09-05" });
    expect(chooseBriefingDay(new Date("2026-09-04T23:30:00Z"), TZ, 14)).toEqual({ label: "morgen", date: "2026-09-05" });
  });
});

const day: DayForecast = { date: "2026-09-04", condition: "rainy", tempMax: 18.6, tempMin: 11.2, precipitationProbability: 70, precipitation: 3, windSpeed: 50 };

describe("phrasing", () => {
  it("builds a Dutch template with greeting, condition, temps, rain and wind", () => {
    const text = buildBriefingTemplate(day, "vandaag", 8);
    expect(text).toBe("Goedemorgen. Vandaag wordt het regenachtig met een maximum van 19 graden en een minimum van 11. De kans op neerslag is 70 procent. Het wordt behoorlijk winderig.");
  });

  it("degrades gracefully with missing numbers", () => {
    const text = buildBriefingTemplate({ ...day, tempMax: null, tempMin: null, precipitationProbability: null, windSpeed: null }, "morgen", 20);
    expect(text).toBe("Goedenavond. Morgen wordt het regenachtig.");
  });

  it("prompt carries the data and the greeting", () => {
    const prompt = buildBriefingPrompt(day, "morgen", 15, "Gillis");
    expect(prompt).toContain("Goedemiddag");
    expect(prompt).toContain("morgen (2026-09-04)");
    expect(prompt).toContain("70 procent");
    expect(prompt).toContain("Gillis");
  });

  it("sanitizes model output", () => {
    expect(sanitizeSpokenText('"**Goedemorgen!** Vandaag  regen."')).toBe("Goedemorgen! Vandaag regen.");
    expect(sanitizeSpokenText("kort")).toBeNull();
    expect(sanitizeSpokenText("x".repeat(500))).toBeNull();
    expect(sanitizeSpokenText(null)).toBeNull();
  });
});

describe("composeWeatherBriefing", () => {
  const base = { now: new Date("2026-09-04T08:00:00Z"), timezone: TZ, eveningHour: 14, ownerName: "Gillis", location: { lat: 52, lon: 4 } };

  it("uses the event forecast and the LLM when available", async () => {
    const llm = { run: vi.fn().mockResolvedValue("Goedemorgen. Vandaag flinke regen, neem een paraplu mee.") };
    const b = await composeWeatherBriefing({ ...base, forecastFromEvent: haForecast, llm });
    expect(b.source).toBe("event");
    expect(b.label).toBe("vandaag");
    expect(b.usedLLM).toBe(true);
    expect(b.text).toContain("paraplu");
    expect(llm.run).toHaveBeenCalledTimes(1);
  });

  it("falls back to the template when the LLM returns nothing", async () => {
    const llm = { run: vi.fn().mockResolvedValue(null) };
    const b = await composeWeatherBriefing({ ...base, forecastFromEvent: haForecast, llm });
    expect(b.usedLLM).toBe(false);
    expect(b.text.startsWith("Goedemorgen. Vandaag wordt het flinke regen")).toBe(true);
  });

  it("falls back to the template when the LLM throws", async () => {
    const llm = { run: vi.fn().mockRejectedValue(new Error("boom")) };
    const b = await composeWeatherBriefing({ ...base, forecastFromEvent: haForecast, llm });
    expect(b.usedLLM).toBe(false);
    expect(b.text).toContain("Vandaag");
  });

  it("prefers Home Assistant over Open-Meteo, and Open-Meteo when HA fails", async () => {
    const fromHA = await composeWeatherBriefing({ ...base, fetchFromHA: async () => haForecast });
    expect(fromHA.source).toBe("homeassistant");

    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ daily: { time: ["2026-09-04"], weather_code: [0], temperature_2m_max: [25], temperature_2m_min: [14], precipitation_sum: [0], precipitation_probability_max: [0], wind_speed_10m_max: [10] } }) });
    const fromMeteo = await composeWeatherBriefing({ ...base, fetchFromHA: async () => { throw new Error("unreachable"); }, fetchFn: fetchFn as unknown as typeof fetch });
    expect(fromMeteo.source).toBe("open-meteo");
    expect(fromMeteo.text).toContain("zonnig");
  });

  it("throws when no forecast covers the chosen day", async () => {
    await expect(composeWeatherBriefing({ ...base, now: new Date("2026-09-20T08:00:00Z"), forecastFromEvent: haForecast, fetchFn: (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch }))
      .rejects.toThrow("No forecast available");
  });
});
