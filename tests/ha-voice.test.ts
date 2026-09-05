import { describe, it, expect, vi, beforeEach } from "vitest";

const disk = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("fs", () => ({
  existsSync: (p: string) => disk.has(p) || p.endsWith("/tts"),
  readdirSync: () => [...disk.keys()].map(k => k.split("/").pop()!),
  readFileSync: (p: string) => disk.get(p),
  statSync: (p: string) => ({ size: disk.get(p)?.length ?? 0, mtimeMs: Date.now() }),
  unlinkSync: (p: string) => { disk.delete(p); },
  writeFileSync: (p: string, data: Buffer) => { disk.set(p, Buffer.from(data)); },
}));
vi.mock("../backend/utils/file-store.js", () => ({
  ensureDir: () => {},
  FileStore: class { load() { return null; } save() {} exists() { return false; } },
  safeReadJSON: <T,>(_p: string, fallback: T) => fallback,
  atomicWriteFile: () => {}, atomicWriteJSON: () => {},
}));
vi.mock("../backend/integrations/homeassistant.js", () => ({
  getPublicBaseUrl: () => "http://agent.example",
}));

import {
  resolveApiKey, isPremiumVoiceConfigured, audioIdFor, buildElevenLabsRequest, buildOpenAIRequest, buildGrokRequest,
  synthesizeSpeech, planSpeech, parseAudioId, handleTtsAudio, TTS_DIR, applyEffect, EFFECT_FILTERS, applySpeechTags,
} from "../backend/ha-voice.js";
import type { HASpeechConfig } from "../backend/integrations/homeassistant.js";
import type { IncomingMessage, ServerResponse } from "http";

const base: HASpeechConfig = {
  mediaPlayer: "media_player.wiim", ttsEngine: "tts.edge", language: "nl-NL-FennaNeural", ttsVolume: 0.3,
  provider: "elevenlabs", voiceId: "voice123", model: "eleven_multilingual_v2", style: "", apiKey: "key-abc",
  effect: "none", speed: 1, speechTags: [],
};

beforeEach(() => disk.clear());

describe("configuration", () => {
  it("resolves the key from config first, then the environment per provider", () => {
    expect(resolveApiKey(base, {})).toBe("key-abc");
    expect(resolveApiKey({ ...base, apiKey: "" }, { ELEVENLABS_API_KEY: "env-el" })).toBe("env-el");
    expect(resolveApiKey({ ...base, apiKey: "", provider: "openai" }, { OPENAI_API_KEY: "env-oa" })).toBe("env-oa");
    expect(resolveApiKey({ ...base, apiKey: "", provider: "grok" }, { GROK_API_KEY: "env-gk" })).toBe("env-gk");
    expect(resolveApiKey({ ...base, apiKey: "", provider: "homeassistant" }, { OPENAI_API_KEY: "x" })).toBe("");
  });

  it("is premium only with a non-HA provider, a key and a public URL", () => {
    expect(isPremiumVoiceConfigured(base, {})).toBe(true);
    expect(isPremiumVoiceConfigured({ ...base, provider: "homeassistant" }, {})).toBe(false);
    expect(isPremiumVoiceConfigured({ ...base, apiKey: "" }, {})).toBe(false);
  });

  it("derives a stable 32-hex id from provider, voice, model, style and text", () => {
    const a = audioIdFor(base, "Hallo");
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(audioIdFor(base, "Hallo")).toBe(a);
    expect(audioIdFor({ ...base, voiceId: "other" }, "Hallo")).not.toBe(a);
    expect(audioIdFor(base, "Hallo!")).not.toBe(a);
    expect(audioIdFor({ ...base, effect: "reverb" }, "Hallo")).not.toBe(a);
  });
});

describe("provider requests", () => {
  it("builds an ElevenLabs request with the multilingual model", () => {
    const r = buildElevenLabsRequest(base, "Goedenavond", "k");
    expect(r.url).toContain("/v1/text-to-speech/voice123?");
    expect(r.headers["xi-api-key"]).toBe("k");
    expect(JSON.parse(r.body)).toMatchObject({ text: "Goedenavond", model_id: "eleven_multilingual_v2" });
  });

  it("builds an OpenAI request with voice, model and instructions", () => {
    const r = buildOpenAIRequest({ ...base, provider: "openai", voiceId: "onyx", model: "gpt-4o-mini-tts", style: "calm" }, "Hoi", "k");
    expect(r.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(r.body)).toEqual({ model: "gpt-4o-mini-tts", voice: "onyx", input: "Hoi", response_format: "mp3", instructions: "calm" });
  });
});

describe("speech tags", () => {
  it("wraps text in nested Grok tags and ignores unknown ones", () => {
    expect(applySpeechTags("Hallo", ["soft", "low", "bogus"])).toBe("<soft><low>Hallo</low></soft>");
    expect(applySpeechTags("Hallo", [])).toBe("Hallo");
    const r = buildGrokRequest({ ...base, provider: "grok", speechTags: ["soft"] }, "Hoi", "k");
    expect(JSON.parse(r.body).text).toBe("<soft>Hoi</soft>");
  });
});

describe("grok request", () => {
  it("posts to xAI with the voice id and the language derived from an Edge voice name", () => {
    const r = buildGrokRequest({ ...base, provider: "grok", voiceId: "eve", language: "nl-NL-FennaNeural" }, "Goedenavond", "k");
    expect(r.url).toBe("https://api.x.ai/v1/tts");
    expect(r.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(r.body)).toMatchObject({ text: "Goedenavond", voice_id: "eve", language: "nl", speed: 1, output_format: { codec: "mp3" } });
    expect(JSON.parse(buildGrokRequest({ ...base, provider: "grok", language: "" }, "x", "k").body).language).toBe("auto");
  });
});

describe("applyEffect", () => {
  it("does nothing for 'none'", async () => {
    const ff = vi.fn();
    expect(await applyEffect("/x.mp3", "none", ff)).toBeNull();
    expect(ff).not.toHaveBeenCalled();
  });

  it("runs ffmpeg with the effect filter and replaces the clip", async () => {
    disk.set("/clip.mp3", Buffer.alloc(3000, 1));
    const ff = vi.fn(async (args: string[]) => { disk.set(args[args.length - 1], Buffer.alloc(4000, 2)); });
    expect(await applyEffect("/clip.mp3", "reverb", ff)).toBe("reverb");
    expect(ff.mock.calls[0][0]).toContain(EFFECT_FILTERS.reverb);
    expect(disk.get("/clip.mp3")!.length).toBe(4000);
    expect(disk.has("/clip.mp3.fx.mp3")).toBe(false);
  });

  it("keeps the dry clip when ffmpeg fails", async () => {
    disk.set("/clip.mp3", Buffer.alloc(3000, 1));
    const ff = vi.fn(async () => { throw new Error("ffmpeg missing"); });
    expect(await applyEffect("/clip.mp3", "computer", ff)).toBeNull();
    expect(disk.get("/clip.mp3")!.length).toBe(3000);
  });
});

describe("synthesizeSpeech / planSpeech", () => {
  const mp3 = Buffer.alloc(5000, 1);

  it("returns null without a premium provider and never calls the network", async () => {
    const fetchFn = vi.fn();
    expect(await synthesizeSpeech("x", { ...base, provider: "homeassistant" }, fetchFn as unknown as typeof fetch)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("stores the clip, returns a public URL and reuses the cached file", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => mp3 });
    const first = await synthesizeSpeech("Goedenavond Gillis", base, fetchFn as unknown as typeof fetch);
    expect(first).toMatchObject({ provider: "elevenlabs", cached: false, bytes: 5000 });
    expect(first!.url).toBe(`http://agent.example/homeassistant/tts/${first!.id}.mp3`);
    expect(disk.has(`${TTS_DIR}/${first!.id}.mp3`)).toBe(true);
    const second = await synthesizeSpeech("Goedenavond Gillis", base, fetchFn as unknown as typeof fetch);
    expect(second!.cached).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws on provider errors and on suspiciously small audio", async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" });
    await expect(synthesizeSpeech("x y z", base, bad as unknown as typeof fetch)).rejects.toThrow("401");
    const tiny = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => Buffer.alloc(10) });
    await expect(synthesizeSpeech("x y z", base, tiny as unknown as typeof fetch)).rejects.toThrow("bytes");
  });

  it("plans a Home Assistant TTS call when premium is off", async () => {
    const plan = await planSpeech("Hallo", { ...base, provider: "homeassistant" });
    expect(plan.provider).toBe("homeassistant");
    expect(plan.audioUrl).toBeNull();
    expect(plan.call).toMatchObject({ domain: "tts", service: "speak", entityId: "tts.edge" });
  });
});

describe("serving clips", () => {
  it("only accepts well-formed ids", () => {
    expect(parseAudioId("/homeassistant/tts/" + "a".repeat(32) + ".mp3")).toBe("a".repeat(32));
    expect(parseAudioId("/homeassistant/tts/../etc/passwd")).toBeNull();
    expect(parseAudioId("/homeassistant/tts/short.mp3")).toBeNull();
  });

  it("serves an existing clip as audio/mpeg and 404s otherwise", () => {
    const id = "b".repeat(32);
    disk.set(`${TTS_DIR}/${id}.mp3`, Buffer.alloc(2048, 7));
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    handleTtsAudio({ url: `/homeassistant/tts/${id}.mp3` } as IncomingMessage, res);
    expect((res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(200);
    expect((res.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][1]["Content-Type"]).toBe("audio/mpeg");

    const res404 = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
    handleTtsAudio({ url: "/homeassistant/tts/" + "c".repeat(32) + ".mp3" } as IncomingMessage, res404);
    expect((res404.writeHead as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(404);
  });
});
