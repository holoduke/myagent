/**
 * Voice message transcription using OpenAI Whisper API.
 * Supports Dutch + 50 other languages automatically.
 * Cost: ~$0.006/min, typical voice msg 5-30s.
 */

import { createLogger } from "../logger.js";

const log = createLogger("transcribe");

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";
const MAX_AUDIO_SIZE_MB = 25; // OpenAI Whisper limit

/**
 * Transcribe an audio buffer using OpenAI Whisper API.
 * Returns the transcribed text, or null on failure.
 */
export async function transcribeAudio(
  buffer: Buffer,
  mimetype: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log("OPENAI_API_KEY not set — skipping voice transcription");
    return null;
  }

  if (buffer.length === 0) {
    log("Empty audio buffer — skipping transcription");
    return null;
  }

  if (buffer.length > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
    log(`Audio too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB > ${MAX_AUDIO_SIZE_MB}MB) — skipping`);
    return null;
  }

  // Map WhatsApp mimetypes to file extensions Whisper expects
  const extMap: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/ogg; codecs=opus": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "audio/amr": "amr",
  };

  const ext = extMap[mimetype] || "ogg";

  try {
    // Build multipart form data manually (no external dependency)
    const boundary = `----whisper${Date.now()}`;
    const filename = `voice.${ext}`;

    const parts: Buffer[] = [];

    // Model field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${WHISPER_MODEL}\r\n`
    ));

    // File field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(WHISPER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      log(`Whisper API error ${response.status}: ${errorText.slice(0, 200)}`);
      return null;
    }

    const result = await response.json() as { text?: string };
    const text = result.text?.trim();

    if (!text) {
      log("Whisper returned empty transcription");
      return null;
    }

    log(`Transcribed ${(buffer.length / 1024).toFixed(0)}KB audio → ${text.length} chars`);
    return text;
  } catch (err) {
    log(`Transcription failed: ${err}`);
    return null;
  }
}
