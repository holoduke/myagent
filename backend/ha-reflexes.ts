/**
 * Home Assistant reflexes — the fast path.
 *
 * A reflex is a deterministic rule ("silver STYRBAR, right arrow") bound to a
 * handler that answers within seconds, using at most a cheap model. Reflexes
 * run inline in the webhook request so Home Assistant can act on the result
 * (speak it, switch something) straight from the HTTP response. The brain
 * learns about the event afterwards through the batched digest.
 *
 * Reflexes:
 *   weather_briefing — today's/tomorrow's forecast (top, bottom, left buttons)
 *   mind_briefing    — what ARIA has on her mind today, from the brain (right arrow)
 */

import { LlmRunner } from "./providers/llm-runner.js";
import { getBrainConfig } from "./brain-config.js";
import { OWNER_NAME } from "./config.js";
import { createLogger } from "./logger.js";
import { composeWeatherBriefing } from "./ha-weather.js";
import { composeMindBriefing } from "./ha-mind.js";
import { loadConfig } from "./integrations/homeassistant.js";
import type { HAConfig, HAButtonRule, HASpeechConfig } from "./integrations/homeassistant.js";
import type { HAEvent } from "./integrations/ha-events.js";
import { buildVolumeCall, getDailyForecast, isHAReachableConfigured } from "./integrations/ha-client.js";
import { planSpeech } from "./ha-voice.js";
import type { VoiceProvider } from "./ha-voice.js";
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
  /** Ready-to-run call for the configured player: play_media (premium clip) or tts.* (HA engine). */
  tts?: ServiceCall;
  /** Public URL of the synthesized clip when a premium voice produced one. */
  audioUrl?: string | null;
  voiceProvider?: VoiceProvider;
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
  rule(config: HAConfig): HAButtonRule;
  run(event: HAEvent, config: HAConfig, now: Date): Promise<ReflexResult>;
}

// ── Matching ──

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** True when the event comes from the configured device (by device name, friendly name or entity id). */
export function eventMatchesDevice(event: HAEvent, configuredDevice: string): boolean {
  const target = normalizeName(configuredDevice);
  if (!target) return false;
  return [event.device, event.friendlyName, event.entityId].some(v => normalizeName(v) === target);
}

/** Pure rule check: enabled, button press, right device, action in the rule's list. */
export function matchesButtonRule(event: HAEvent, rule: HAButtonRule): boolean {
  if (!rule.enabled) return false;
  if (event.type !== "button_press") return false;
  if (!eventMatchesDevice(event, rule.device)) return false;
  const action = (event.action ?? "").toLowerCase();
  return rule.actions.some(a => a.toLowerCase() === action);
}

// ── Speaking ──

function runner(model: string | undefined): LlmRunner {
  return new LlmRunner({ name: "ha-reflex", timeout: REFLEX_LLM_TIMEOUT_MS, model: model ?? "haiku" });
}

/**
 * Decide how `text` is spoken (premium clip or HA engine) and, when the rule
 * asks for it, push volume + speech from the server. Returns how the house
 * will end up hearing it.
 */
async function deliverSpeech(text: string, speech: HASpeechConfig, rule: HAButtonRule, reason: string): Promise<{ tts: ServiceCall; audioUrl: string | null; voiceProvider: VoiceProvider; delivery: ReflexResult["delivery"] }> {
  const plan = await planSpeech(text, speech);
  const base = { tts: plan.call, audioUrl: plan.audioUrl, voiceProvider: plan.provider };
  if (!rule.pushTts) return { ...base, delivery: "response" };
  try {
    if (speech.ttsVolume !== null) {
      await dispatchCommand(buildVolumeCall(speech.mediaPlayer, speech.ttsVolume), "reflex", "announcement volume");
    }
    const result = await dispatchCommand(plan.call, "reflex", reason);
    return { ...base, delivery: result.mode === "direct" ? "push" : "response" };
  } catch (err) {
    log(`Push speech failed (house will use the response instead): ${err}`);
    return { ...base, delivery: "response" };
  }
}

// ── Reflexes ──

export const weatherBriefingReflex: ReflexDefinition = {
  id: "weather_briefing",
  label: "Weather briefing",
  rule: config => config.reflexes.weatherBriefing,
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
      llm: runner(brain.models?.haReflex),
    });
    const { tts, audioUrl, voiceProvider, delivery } = await deliverSpeech(briefing.text, config.speech, cfg, "weather briefing");
    return {
      reflexId: this.id,
      speak: briefing.text,
      tts,
      audioUrl,
      voiceProvider,
      summary: `spoke the weather for ${briefing.label} (${briefing.source}${briefing.usedLLM ? ", llm" : ", template"}): "${briefing.text.slice(0, 120)}"`,
      usedLLM: briefing.usedLLM,
      durationMs: Date.now() - started,
      delivery,
    };
  },
};

export const mindBriefingReflex: ReflexDefinition = {
  id: "mind_briefing",
  label: "What's on ARIA's mind today",
  rule: config => config.reflexes.mindBriefing,
  async run(_event, config, now) {
    const started = Date.now();
    const brain = getBrainConfig();
    const briefing = await composeMindBriefing({ now, ownerName: OWNER_NAME, llm: runner(brain.models?.haMind) });
    const { tts, audioUrl, voiceProvider, delivery } = await deliverSpeech(briefing.text, config.speech, config.reflexes.mindBriefing, "mind briefing");
    return {
      reflexId: this.id,
      speak: briefing.text,
      tts,
      audioUrl,
      voiceProvider,
      summary: `told what was on her mind (${briefing.observationCount} obs today${briefing.usedLLM ? ", llm" : ", template"}): "${briefing.text.slice(0, 120)}"`,
      usedLLM: briefing.usedLLM,
      durationMs: Date.now() - started,
      delivery,
    };
  },
};

export const REFLEXES: ReflexDefinition[] = [weatherBriefingReflex, mindBriefingReflex];

export function getReflex(id: string): ReflexDefinition | undefined {
  return REFLEXES.find(r => r.id === id);
}

/** Pure matcher: first reflex whose rule accepts the event. */
export function findReflex(event: HAEvent, config: HAConfig): ReflexDefinition | null {
  return REFLEXES.find(r => matchesButtonRule(event, r.rule(config))) ?? null;
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
  const reflex = getReflex(reflexId);
  if (!reflex) throw new Error(`Unknown reflex "${reflexId}"`);
  const rule = reflex.rule(config);
  const event: HAEvent = {
    id: "hae_test",
    receivedAt: now.getTime(),
    ts: now.getTime(),
    type: "button_press",
    device: rule.device,
    action: rule.actions[0] ?? "on",
  };
  return reflex.run(event, config, now);
}
