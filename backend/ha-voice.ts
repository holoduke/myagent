/**
 * Premium voice for the house — server-side speech synthesis.
 *
 * Home Assistant's own TTS engines are fine but not "HAL". With an ElevenLabs
 * or OpenAI key, ARIA synthesizes the audio herself, stores the MP3 under
 * /data/homeassistant/tts and hands Home Assistant a public URL to play on
 * the speaker (Google Cast fetches it straight from the agent). When no key is
 * configured, or synthesis fails, everything falls back to Home Assistant's
 * TTS engine so the button always answers.
 *
 * GET /homeassistant/tts/<id>.mp3 is public by necessity (the speaker cannot
 * send headers): ids are 32 random hex chars and files expire after a day.
 */

import { createHash, randomBytes } from "crypto";
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

export type VoiceProvider = "homeassistant" | "elevenlabs" | "openai";

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
  return "";
}

export function isPremiumVoiceConfigured(speech: HASpeechConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return speech.provider !== "homeassistant" && !!resolveApiKey(speech, env) && !!getPublicBaseUrl();
}

/** Deterministic id per (provider, voice, model, text) so repeated phrases reuse the file. */
export function audioIdFor(speech: HASpeechConfig, text: string): string {
  return createHash("sha256")
    .update(`${speech.provider}|${speech.voiceId}|${speech.model}|${speech.style}|${text}`)
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

export function buildSynthRequest(speech: HASpeechConfig, text: string, apiKey: string): SynthRequest {
  if (speech.provider === "elevenlabs") return buildElevenLabsRequest(speech, text, apiKey);
  if (speech.provider === "openai") return buildOpenAIRequest(speech, text, apiKey);
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
  pruneAudioDir();
  log(`Synthesized ${audio.length} bytes with ${speech.provider}/${speech.voiceId} in ${Date.now() - started}ms`);
  return { id, url: audioUrlFor(id), path, bytes: audio.length, provider: speech.provider, cached: false };
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
