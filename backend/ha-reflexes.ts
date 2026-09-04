/**
 * Home Assistant reflexes — the fast path.
 *
 * A reflex is a deterministic rule ("silver STYRBAR short-pressed") bound to a
 * handler that answers within seconds, using at most a cheap model. Reflexes
 * run inline in the webhook request so Home Assistant can act on the result
 * (speak it, switch something) straight from the HTTP response. The brain
 * learns about the event afterwards through the batched digest.
 *
 * First reflex: weather briefing on the IKEA STYRBAR.
 */

import { LlmRunner } from "./providers/llm-runner.js";
import { getBrainConfig } from "./brain-config.js";
import { OWNER_NAME } from "./config.js";
import { createLogger } from "./logger.js";
import { composeWeatherBriefing } from "./ha-weather.js";
import { loadConfig } from "./integrations/homeassistant.js";
import type { HAConfig, HAWeatherReflexConfig } from "./integrations/homeassistant.js";
import type { HAEvent } from "./integrations/ha-events.js";
import { buildTtsCall, buildVolumeCall, getDailyForecast, isHAReachableConfigured } from "./integrations/ha-client.js";
import type { ServiceCall } from "./integrations/ha-client.js";
import { dispatchCommand } from "./integrations/ha-commands.js";

const log = createLogger("ha-reflexes");

/** The house waits for this response; past this the deterministic template speaks instead. */
const REFLEX_LLM_TIMEOUT_MS = 12_000;
/** Same reflex will not fire twice within this window (double taps, retries). */
export const REFLEX_COOLDOWN_MS = 4_000;

export interface ReflexResult {
  reflexId: string;
  /** Text for Home Assistant to speak (if the reflex produced speech). */
  speak?: string;
  /** Ready-to-run TTS call for the configured player (informational for HA, executed on push). */
  tts?: ServiceCall;
  /** One-line summary for the digest/dashboard. */
  summary: string;
  usedLLM: boolean;
  durationMs: number;
  /** "response": HA speaks from the HTTP response; "push": ARIA also sent it directly. */
  delivery: "response" | "push";
}

export interface ReflexDefinition {
  id: string;
  label: string;
  matches(event: HAEvent, config: HAConfig): boolean;
  run(event: HAEvent, config: HAConfig, now: Date): Promise<ReflexResult>;
}

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** True when the event comes from the configured device (by device name, friendly name or entity id). */
export function eventMatchesDevice(event: HAEvent, configuredDevice: string): boolean {
  const target = normalizeName(configuredDevice);
  if (!target) return false;
  return [event.device, event.friendlyName, event.entityId].some(v => normalizeName(v) === target);
}

export function matchesWeatherReflex(event: HAEvent, cfg: HAWeatherReflexConfig): boolean {
  if (!cfg.enabled) return false;
  if (event.type !== "button_press") return false;
  if (!eventMatchesDevice(event, cfg.device)) return false;
  const action = (event.action ?? "").toLowerCase();
  return cfg.actions.some(a => a.toLowerCase() === action);
}

function reflexLlm(): LlmRunner {
  return new LlmRunner({
    name: "ha-reflex",
    timeout: REFLEX_LLM_TIMEOUT_MS,
    model: getBrainConfig().models?.haReflex ?? "haiku",
  });
}

export const weatherBriefingReflex: ReflexDefinition = {
  id: "weather_briefing",
  label: "Weather briefing on button press",
  matches: (event, config) => matchesWeatherReflex(event, config.reflexes.weatherBriefing),
  async run(event, config, now) {
    const started = Date.now();
    const cfg = config.reflexes.weatherBriefing;
    const brain = getBrainConfig();
    const briefing = await composeWeatherBriefing({
      now,
      timezone: brain.ownerTimezone,
      eveningHour: cfg.eveningHour,
      ownerName: OWNER_NAME,
      location: config.location,
      forecastFromEvent: event.context?.forecast,
      fetchFromHA: isHAReachableConfigured() ? () => getDailyForecast(cfg.weatherEntity) : undefined,
      llm: reflexLlm(),
    });

    const tts = buildTtsCall(briefing.text, { player: cfg.mediaPlayer, engine: cfg.ttsEngine, language: cfg.language });
    let delivery: ReflexResult["delivery"] = "response";
    if (cfg.pushTts) {
      try {
        if (cfg.ttsVolume !== null) {
          await dispatchCommand(buildVolumeCall(cfg.mediaPlayer, cfg.ttsVolume), "reflex", "announcement volume");
        }
        const result = await dispatchCommand(tts, "reflex", "weather briefing");
        if (result.mode === "direct") delivery = "push";
      } catch (err) {
        log(`Push TTS failed (house will use the response instead): ${err}`);
      }
    }

    return {
      reflexId: this.id,
      speak: briefing.text,
      tts,
      summary: `spoke the weather for ${briefing.label} (${briefing.source}${briefing.usedLLM ? ", llm" : ", template"}): "${briefing.text.slice(0, 120)}"`,
      usedLLM: briefing.usedLLM,
      durationMs: Date.now() - started,
      delivery,
    };
  },
};

export const REFLEXES: ReflexDefinition[] = [weatherBriefingReflex];

export function getReflex(id: string): ReflexDefinition | undefined {
  return REFLEXES.find(r => r.id === id);
}

/** Pure matcher: first reflex whose rule accepts the event. */
export function findReflex(event: HAEvent, config: HAConfig): ReflexDefinition | null {
  return REFLEXES.find(r => r.matches(event, config)) ?? null;
}

const lastFiredAt = new Map<string, number>();

export function isOnCooldown(reflexId: string, now: number): boolean {
  const last = lastFiredAt.get(reflexId) ?? 0;
  return now - last < REFLEX_COOLDOWN_MS;
}

/**
 * Run the matching reflex for an event, if any. Never throws: failures are
 * logged and reported as `null` so the event still gets buffered.
 */
export async function runReflexForEvent(event: HAEvent, now: Date = new Date()): Promise<ReflexResult | null> {
  const config = loadConfig();
  if (!config) return null;
  const reflex = findReflex(event, config);
  if (!reflex) return null;
  if (isOnCooldown(reflex.id, now.getTime())) {
    log(`Reflex ${reflex.id} on cooldown — ignoring repeat press`);
    return null;
  }
  lastFiredAt.set(reflex.id, now.getTime());
  try {
    const result = await reflex.run(event, config, now);
    log(`Reflex ${reflex.id} done in ${result.durationMs}ms: ${result.summary}`);
    return result;
  } catch (err) {
    log(`Reflex ${reflex.id} failed: ${err}`);
    return null;
  }
}

/** Dashboard/test helper: run a reflex with a synthetic event, bypassing cooldown. */
export async function testReflex(reflexId: string, now: Date = new Date()): Promise<ReflexResult> {
  const config = loadConfig();
  if (!config) throw new Error("Home Assistant is not configured");
  const reflex = getReflex(reflexId);
  if (!reflex) throw new Error(`Unknown reflex "${reflexId}"`);
  const cfg = config.reflexes.weatherBriefing;
  const event: HAEvent = {
    id: "hae_test",
    receivedAt: now.getTime(),
    ts: now.getTime(),
    type: "button_press",
    device: cfg.device,
    action: cfg.actions[0] ?? "on",
  };
  return reflex.run(event, config, now);
}
