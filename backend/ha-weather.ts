/**
 * Weather briefing for the Home Assistant reflexes.
 *
 * Forecast sources, in order of preference:
 *   1. a forecast Home Assistant included in the event payload (free, local)
 *   2. Home Assistant's weather entity via the API (only when reachable)
 *   3. Open-Meteo (no key, works from the server) for the configured location
 *
 * Before `eveningHour` (owner-local) the briefing covers today; after it,
 * tomorrow. Phrasing goes through a cheap LLM with a deterministic Dutch
 * template as fallback, so the house always gets an answer.
 */

import { getOwnerLocalDate, getOwnerLocalTime } from "./brain-config.js";
import { createLogger } from "./logger.js";

const log = createLogger("ha-weather");

export interface DayForecast {
  /** YYYY-MM-DD in the owner's timezone. */
  date: string;
  condition: string;
  tempMax: number | null;
  tempMin: number | null;
  precipitationProbability: number | null;
  precipitation: number | null;
  windSpeed: number | null;
}

export type BriefingDay = "vandaag" | "morgen";

// ── Normalization ──

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Convert Home Assistant `weather.get_forecasts` daily entries into DayForecast. */
export function normalizeHAForecast(raw: unknown, timezone: string): DayForecast[] {
  if (!Array.isArray(raw)) return [];
  const days: DayForecast[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const stamp = typeof e.datetime === "string" ? Date.parse(e.datetime) : NaN;
    if (Number.isNaN(stamp)) continue;
    days.push({
      date: getOwnerLocalDate(timezone, new Date(stamp)),
      condition: typeof e.condition === "string" ? e.condition : "unknown",
      tempMax: num(e.temperature),
      tempMin: num(e.templow),
      precipitationProbability: num(e.precipitation_probability),
      precipitation: num(e.precipitation),
      windSpeed: num(e.wind_speed),
    });
  }
  return days;
}

/** WMO weather codes (Open-Meteo) → Home Assistant condition vocabulary. */
const WMO_RANGES: Array<[from: number, to: number, condition: string]> = [
  [0, 0, "sunny"],
  [1, 2, "partlycloudy"],
  [3, 3, "cloudy"],
  [45, 48, "fog"],
  [51, 64, "rainy"],
  [65, 65, "pouring"],
  [66, 67, "snowy-rainy"],
  [71, 77, "snowy"],
  [80, 81, "rainy"],
  [82, 82, "pouring"],
  [85, 86, "snowy"],
  [95, 99, "lightning-rainy"],
];

export function wmoToCondition(code: number): string {
  return WMO_RANGES.find(([from, to]) => code >= from && code <= to)?.[2] ?? "unknown";
}

interface OpenMeteoDaily {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  precipitation_sum: number[];
  precipitation_probability_max: number[];
  wind_speed_10m_max: number[];
}

export function normalizeOpenMeteo(raw: unknown): DayForecast[] {
  const daily = (raw as { daily?: Partial<OpenMeteoDaily> } | null)?.daily;
  if (!daily || !Array.isArray(daily.time)) return [];
  return daily.time.map((date, i) => ({
    date,
    condition: wmoToCondition(num(daily.weather_code?.[i]) ?? -1),
    tempMax: num(daily.temperature_2m_max?.[i]),
    tempMin: num(daily.temperature_2m_min?.[i]),
    precipitationProbability: num(daily.precipitation_probability_max?.[i]),
    precipitation: num(daily.precipitation_sum?.[i]),
    windSpeed: num(daily.wind_speed_10m_max?.[i]),
  }));
}

export async function fetchOpenMeteoForecast(
  location: { lat: number; lon: number },
  timezone: string,
  fetchFn: typeof fetch = fetch,
): Promise<DayForecast[]> {
  const params = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
    timezone,
    forecast_days: "3",
  });
  const res = await fetchFn(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  return normalizeOpenMeteo(await res.json());
}

// ── Day selection ──

/** Today before `eveningHour` (owner-local), tomorrow from then on. */
export function chooseBriefingDay(now: Date, timezone: string, eveningHour: number): { label: BriefingDay; date: string } {
  const { hour } = getOwnerLocalTime(timezone, now);
  if (hour < eveningHour) return { label: "vandaag", date: getOwnerLocalDate(timezone, now) };
  return { label: "morgen", date: getOwnerLocalDate(timezone, new Date(now.getTime() + 24 * 60 * 60 * 1000)) };
}

export function findForecastForDate(days: DayForecast[], date: string): DayForecast | null {
  return days.find(d => d.date === date) ?? null;
}

// ── Phrasing ──

const CONDITION_NL: Record<string, string> = {
  "clear-night": "helder",
  cloudy: "bewolkt",
  exceptional: "uitzonderlijk weer",
  fog: "mistig",
  hail: "hagel",
  lightning: "onweer",
  "lightning-rainy": "onweer met regen",
  partlycloudy: "half bewolkt",
  pouring: "flinke regen",
  rainy: "regenachtig",
  snowy: "sneeuw",
  "snowy-rainy": "natte sneeuw",
  sunny: "zonnig",
  windy: "winderig",
  "windy-variant": "winderig",
  unknown: "wisselvallig",
};

export function conditionToDutch(condition: string): string {
  return CONDITION_NL[condition] ?? condition.replace(/-/g, " ");
}

export function greetingForHour(hour: number): string {
  if (hour < 6) return "Goedenacht";
  if (hour < 12) return "Goedemorgen";
  if (hour < 18) return "Goedemiddag";
  return "Goedenavond";
}

function round(value: number | null): string {
  return value === null ? "onbekend" : String(Math.round(value));
}

/** Deterministic Dutch fallback — always valid, never needs a model. */
export function buildBriefingTemplate(day: DayForecast, label: BriefingDay, hour: number): string {
  const parts = [`${greetingForHour(hour)}. ${label === "vandaag" ? "Vandaag" : "Morgen"} wordt het ${conditionToDutch(day.condition)}`];
  if (day.tempMax !== null) {
    parts[0] += ` met een maximum van ${round(day.tempMax)} graden`;
    if (day.tempMin !== null) parts[0] += ` en een minimum van ${round(day.tempMin)}`;
  }
  parts[0] += ".";
  if (day.precipitationProbability !== null) {
    parts.push(`De kans op neerslag is ${round(day.precipitationProbability)} procent.`);
  }
  if (day.windSpeed !== null && day.windSpeed >= 40) {
    parts.push("Het wordt behoorlijk winderig.");
  }
  return parts.join(" ");
}

export function buildBriefingPrompt(day: DayForecast, label: BriefingDay, hour: number, ownerName: string): string {
  return `Je bent ARIA, de huis-assistent van ${ownerName}. Iemand drukte op de weerknop; je antwoord wordt hardop uitgesproken via een speaker.

Schrijf een korte gesproken weersverwachting voor ${label} in natuurlijk Nederlands.
Regels:
- Begin met "${greetingForHour(hour)}".
- Maximaal 2 zinnen, spreektaal, geen emoji, geen opsomming, geen markdown, geen cijfers met decimalen.
- Noem het weerbeeld, de maximumtemperatuur en de kans op neerslag. Geef één praktische tip als het relevant is (paraplu, zonnebrand, jas).
- Verzin niets dat niet in de gegevens staat.

Gegevens voor ${label} (${day.date}):
- weerbeeld: ${conditionToDutch(day.condition)}
- maximum: ${round(day.tempMax)} graden, minimum: ${round(day.tempMin)} graden
- kans op neerslag: ${round(day.precipitationProbability)} procent, neerslag: ${day.precipitation ?? "onbekend"} mm
- wind: ${round(day.windSpeed)} km/u

Antwoord met alleen de gesproken tekst.`;
}

/** Guard against a model returning markdown, quotes or something far too long to speak. */
export function sanitizeSpokenText(raw: string | null | undefined, maxLength = 400): string | null {
  if (!raw) return null;
  const text = raw.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
  if (text.length < 15 || text.length > maxLength) return null;
  return text;
}

// ── Orchestration ──

export interface WeatherBriefingOptions {
  now: Date;
  timezone: string;
  eveningHour: number;
  ownerName: string;
  location: { lat: number; lon: number };
  /** Forecast entries embedded in the event by Home Assistant, if any. */
  forecastFromEvent?: unknown;
  /** Fetches the forecast from Home Assistant; return [] or throw when unreachable. */
  fetchFromHA?: () => Promise<unknown[]>;
  /** Cheap LLM; null result → template fallback. */
  llm?: { run(prompt: string): Promise<string | null> };
  fetchFn?: typeof fetch;
}

export interface WeatherBriefing {
  text: string;
  label: BriefingDay;
  day: DayForecast;
  source: "event" | "homeassistant" | "open-meteo";
  usedLLM: boolean;
}

async function resolveForecast(opts: WeatherBriefingOptions): Promise<{ days: DayForecast[]; source: WeatherBriefing["source"] }> {
  const fromEvent = normalizeHAForecast(opts.forecastFromEvent, opts.timezone);
  if (fromEvent.length > 0) return { days: fromEvent, source: "event" };

  if (opts.fetchFromHA) {
    try {
      const fromHA = normalizeHAForecast(await opts.fetchFromHA(), opts.timezone);
      if (fromHA.length > 0) return { days: fromHA, source: "homeassistant" };
    } catch (err) {
      log(`Home Assistant forecast unavailable, falling back to Open-Meteo: ${err}`);
    }
  }

  const fromMeteo = await fetchOpenMeteoForecast(opts.location, opts.timezone, opts.fetchFn);
  return { days: fromMeteo, source: "open-meteo" };
}

export async function composeWeatherBriefing(opts: WeatherBriefingOptions): Promise<WeatherBriefing> {
  const { label, date } = chooseBriefingDay(opts.now, opts.timezone, opts.eveningHour);
  const { days, source } = await resolveForecast(opts);
  const day = findForecastForDate(days, date);
  if (!day) throw new Error(`No forecast available for ${date} (source: ${source}, ${days.length} days)`);

  const { hour } = getOwnerLocalTime(opts.timezone, opts.now);
  let text: string | null = null;
  let usedLLM = false;
  if (opts.llm) {
    try {
      text = sanitizeSpokenText(await opts.llm.run(buildBriefingPrompt(day, label, hour, opts.ownerName)));
      usedLLM = text !== null;
    } catch (err) {
      log(`Briefing LLM failed, using template: ${err}`);
    }
  }
  return { text: text ?? buildBriefingTemplate(day, label, hour), label, day, source, usedLLM };
}
