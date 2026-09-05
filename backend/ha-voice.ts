/**
 * Premium voice for the house — server-side speech synthesis.
 *
 * Home Assistant's own TTS engines are fine but not "HAL". With a Grok (xAI),
 * ElevenLabs or OpenAI key, ARIA synthesizes the audio herself, stores the MP3 under
 * /data/homeassistant/tts and hands Home Assistant a public URL to play on
 * the speaker (Google Cast fetches it straight from the agent). When no key is
 * configured, or synthesis fails, everything falls back to Home Assistant's
 * TTS engine so the button always answers.
 *
 * GET /homeassistant/tts/<id>.mp3 is public by necessity (the speaker cannot
 * send headers): ids are 32 random hex chars and files expire after a day.
 */

import { createHash } from "crypto";
import { execFile } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { IncomingMessage, ServerResponse } from "http";
import { ensureDir } from "./utils/file-store.js";
import { createLogger } from "./logger.js";
import { getPublicBaseUrl } from "./integrations/homeassistant.js";
import type { HASpeechConfig } from "./integrations/homeassistant.js";
import { HA_DIR } from "./integrations/ha-events.js";
import { buildTtsCall } from "./integrations/ha-client.js";
import type { ServiceCall } from "./integrations/ha-client.js";

const log = createLogger("ha-voice");

export const TTS_DIR = `${HA_DIR}/tts`;
const AUDIO_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AUDIO_FILES = 200;
const SYNTH_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 1500;
const ID_RE = /^[a-f0-9]{32}$/;

export type VoiceProvider = "homeassistant" | "elevenlabs" | "openai" | "grok";
export type VoiceEffect = "none" | "reverb" | "computer";

/**
 * ffmpeg audio filters per effect. "reverb": a small hall (multi-tap echo).
 * "computer": band-limited, slightly darker, longer soft tail — the ship's
 * computer treatment. Applied after synthesis, cached per effect.
 */
export const EFFECT_FILTERS: Record<Exclude<VoiceEffect, "none">, string> = {
  reverb: "aecho=0.8:0.85:28|52|80:0.35|0.22|0.12,alimiter=limit=0.95",
  computer: "highpass=f=180,lowpass=f=5200,aecho=0.75:0.8:35|70|110|160:0.4|0.28|0.18|0.1,alimiter=limit=0.95",
};
const FFMPEG_TIMEOUT_MS = 20_000;

export interface SynthesizedAudio {
  id: string;
  url: string;
  path: string;
  bytes: number;
  provider: VoiceProvider;
  cached: boolean;
}

/** Resolve the API key: dashboard-stored key first, then environment. */
export function resolveApiKey(speech: HASpeechConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (speech.apiKey) return speech.apiKey;
  if (speech.provider === "elevenlabs") return env.ELEVENLABS_API_KEY || "";
  if (speech.provider === "openai") return env.OPENAI_API_KEY || "";
  if (speech.provider === "grok") return env.XAI_API_KEY || env.GROK_API_KEY || "";
  return "";
}

export function isPremiumVoiceConfigured(speech: HASpeechConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return speech.provider !== "homeassistant" && !!resolveApiKey(speech, env) && !!getPublicBaseUrl();
}

/** Deterministic id per (provider, voice, model, text) so repeated phrases reuse the file. */
export function audioIdFor(speech: HASpeechConfig, text: string): string {
  return createHash("sha256")
    .update(`${speech.provider}|${speech.voiceId}|${speech.model}|${speech.style}|${speech.effect}|${speech.speed}|${(speech.speechTags ?? []).join(",")}|${text}`)
    .digest("hex")
    .slice(0, 32);
}

export function audioUrlFor(id: string): string {
  return `${getPublicBaseUrl()}/homeassistant/tts/${id}.mp3`;
}

// ── Provider requests ──

export interface SynthRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export function buildElevenLabsRequest(speech: HASpeechConfig, text: string, apiKey: string): SynthRequest {
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(speech.voiceId)}?output_format=mp3_44100_128`,
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: speech.model || "eleven_multilingual_v2",
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
  };
}

export function buildOpenAIRequest(speech: HASpeechConfig, text: string, apiKey: string): SynthRequest {
  return {
    url: "https://api.openai.com/v1/audio/speech",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: speech.model || "gpt-4o-mini-tts",
      voice: speech.voiceId || "onyx",
      input: text,
      response_format: "mp3",
      ...(speech.style ? { instructions: speech.style } : {}),
    }),
  };
}

/** xAI text-to-speech: raw MP3 back, BCP-47 language, voice ids like eve/ara/rex/sal/leo. */
export const GROK_WRAP_TAGS = new Set(["soft", "low", "whisper", "loud", "high", "sing"]);

/** Wrap text in Grok delivery tags (<soft><low>…</low></soft>); unknown tags are ignored. */
export function applySpeechTags(text: string, tags: string[]): string {
  const valid = tags.filter(t => GROK_WRAP_TAGS.has(t));
  if (valid.length === 0) return text;
  return `${valid.map(t => `<${t}>`).join("")}${text}${[...valid].reverse().map(t => `</${t}>`).join("")}`;
}

export function buildGrokRequest(speech: HASpeechConfig, text: string, apiKey: string): SynthRequest {
  // speech.language may be an Edge voice name ("nl-NL-FennaNeural"); xAI wants the language itself.
  const primary = (speech.language || "").split("-")[0].toLowerCase();
  return {
    url: "https://api.x.ai/v1/tts",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: applySpeechTags(text, speech.speechTags ?? []),
      voice_id: speech.voiceId || "eve",
      language: /^[a-z]{2}$/.test(primary) ? primary : "auto",
      speed: Math.min(1.5, Math.max(0.7, speech.speed || 1)),
      output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
    }),
  };
}

export function buildSynthRequest(speech: HASpeechConfig, text: string, apiKey: string): SynthRequest {
  if (speech.provider === "elevenlabs") return buildElevenLabsRequest(speech, text, apiKey);
  if (speech.provider === "openai") return buildOpenAIRequest(speech, text, apiKey);
  if (speech.provider === "grok") return buildGrokRequest(speech, text, apiKey);
  throw new Error(`No synthesis for provider "${speech.provider}"`);
}

// ── Storage ──

function pruneAudioDir(now: number = Date.now()): void {
  try {
    if (!existsSync(TTS_DIR)) return;
    const files = readdirSync(TTS_DIR)
      .filter(f => f.endsWith(".mp3"))
      .map(f => ({ f, mtime: statSync(`${TTS_DIR}/${f}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach(({ f, mtime }, i) => {
      if (i >= MAX_AUDIO_FILES || now - mtime > AUDIO_TTL_MS) unlinkSync(`${TTS_DIR}/${f}`);
    });
  } catch (err) {
    log(`Audio prune failed: ${err}`);
  }
}

/**
 * Synthesize `text` with the configured premium provider. Returns null when
 * no provider/key is configured; throws on provider errors (callers fall back).
 */
export async function synthesizeSpeech(
  text: string,
  speech: HASpeechConfig,
  fetchFn: typeof fetch = fetch,
): Promise<SynthesizedAudio | null> {
  if (!isPremiumVoiceConfigured(speech)) return null;
  const clean = text.trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) return null;

  const id = audioIdFor(speech, clean);
  const path = `${TTS_DIR}/${id}.mp3`;
  ensureDir(TTS_DIR);
  if (existsSync(path)) {
    return { id, url: audioUrlFor(id), path, bytes: statSync(path).size, provider: speech.provider, cached: true };
  }

  const request = buildSynthRequest(speech, clean, resolveApiKey(speech));
  const started = Date.now();
  const res = await fetchFn(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${speech.provider} returned ${res.status}: ${detail}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) throw new Error(`${speech.provider} returned ${audio.length} bytes of audio`);
  writeFileSync(path, audio);
  const effect = await applyEffect(path, speech.effect);
  pruneAudioDir();
  log(`Synthesized ${audio.length} bytes with ${speech.provider}/${speech.voiceId}${effect ? ` + ${effect}` : ""} in ${Date.now() - started}ms`);
  return { id, url: audioUrlFor(id), path, bytes: statSync(path).size, provider: speech.provider, cached: false };
}

// ── Effects (ffmpeg) ──

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: FFMPEG_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${err.message} ${String(stderr).slice(-200)}`));
      else resolve();
    });
  });
}

/**
 * Apply the configured effect to the clip in place. Returns the effect name
 * when applied, null when there is nothing to do or ffmpeg is unavailable
 * (the raw clip stays — a dry voice beats no voice).
 */
export async function applyEffect(path: string, effect: VoiceEffect, ffmpeg: (args: string[]) => Promise<void> = runFfmpeg): Promise<VoiceEffect | null> {
  if (effect === "none" || !EFFECT_FILTERS[effect]) return null;
  const tmp = `${path}.fx.mp3`;
  try {
    await ffmpeg(["-y", "-loglevel", "error", "-i", path, "-af", EFFECT_FILTERS[effect], "-codec:a", "libmp3lame", "-b:a", "128k", tmp]);
    const processed = readFileSync(tmp);
    if (processed.length < 1000) throw new Error(`ffmpeg produced ${processed.length} bytes`);
    writeFileSync(path, processed);
    return effect;
  } catch (err) {
    log(`Effect "${effect}" skipped: ${err}`);
    return null;
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Service calls ──

/** Play a synthesized clip on the speaker. */
export function buildPlayAudioCall(player: string, url: string): ServiceCall {
  return {
    domain: "media_player",
    service: "play_media",
    entityId: player,
    data: { media_content_id: url, media_content_type: "music" },
  };
}

export interface SpeechPlan {
  /** Service call for the house: play_media (premium clip) or tts.* (Home Assistant engine). */
  call: ServiceCall;
  audioUrl: string | null;
  provider: VoiceProvider;
}

/**
 * Decide how `text` gets spoken: premium clip when possible, Home Assistant
 * TTS otherwise. Never throws — synthesis failures degrade to the HA engine.
 */
export async function planSpeech(text: string, speech: HASpeechConfig, player: string = speech.mediaPlayer): Promise<SpeechPlan> {
  try {
    const audio = await synthesizeSpeech(text, speech);
    if (audio) return { call: buildPlayAudioCall(player, audio.url), audioUrl: audio.url, provider: audio.provider };
  } catch (err) {
    log(`Premium voice failed, falling back to Home Assistant TTS: ${err}`);
  }
  return {
    call: buildTtsCall(text, { player, engine: speech.ttsEngine, language: speech.language }),
    audioUrl: null,
    provider: "homeassistant",
  };
}

// ── HTTP: serve clips ──

export function parseAudioId(pathname: string): string | null {
  const m = /^\/homeassistant\/tts\/([a-f0-9]{32})\.mp3$/.exec(pathname);
  return m && ID_RE.test(m[1]) ? m[1] : null;
}

export function handleTtsAudio(req: IncomingMessage, res: ServerResponse): void {
  const id = parseAudioId((req.url || "").split("?")[0]);
  const path = id ? `${TTS_DIR}/${id}.mp3` : "";
  if (!id || !existsSync(path)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }
  try {
    const data = readFileSync(path);
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Content-Length": data.length,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "none",
    });
    res.end(data);
  } catch (err) {
    log(`Failed to serve audio ${id}: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Audio unavailable" }));
  }
}
