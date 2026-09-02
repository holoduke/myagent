/**
 * Image understanding using Claude CLI with built-in vision.
 * Reuses the LlmRunner pattern — spawns `claude -p ... --model haiku`.
 * Saves image to temp file, asks Claude to read & describe it.
 * Cost: ~$0.0004/image via Haiku.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { LlmRunner } from "../providers/llm-runner.js";
import { getBrainConfig } from "../brain-config.js";
import { createLogger } from "../logger.js";

const log = createLogger("vision");

const TEMP_DIR = "/tmp/aria-vision";
const MAX_IMAGE_SIZE_MB = 10;
const CAPTION_FAILURE_LOG = "/data/brain/caption-failures.jsonl";

/**
 * Classified reason a caption attempt failed. Used both by describeImage's
 * internal checks and by the whatsapp.ts image branch (download errors,
 * late refusal re-check).
 */
export type CaptionFailureReason =
  | "download-error"   // downloadMediaMessage threw before we had a buffer
  | "vision-disabled"  // brain/vision disabled in config
  | "empty-buffer"     // downloaded media was 0 bytes
  | "image-too-large"  // over MAX_IMAGE_SIZE_MB
  | "empty-result"     // vision LLM returned nothing
  | "refusal"          // isVisionRefusal caught it inside describeImage
  | "late-refusal"     // slipped past describeImage, caught by caller's re-check
  | "exception";       // describeImage (or the runner) threw

export interface DescribeImageResult {
  description: string | null;
  failureReason?: CaptionFailureReason;
  /** First ~120 chars of the refusal/error text, for diagnostics. */
  failureSnippet?: string;
}

/**
 * Append a structured caption-failure entry to the diagnostics JSONL.
 * Best-effort: a logging failure must never break message processing.
 */
export function logCaptionFailure(entry: {
  chatJid: string;
  mimetype: string;
  reason: CaptionFailureReason;
  snippet?: string;
}): void {
  try {
    const dir = dirname(CAPTION_FAILURE_LOG);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(
      CAPTION_FAILURE_LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch (err) {
    log(`Failed to write caption-failure log: ${err}`);
  }
}

/**
 * Detect refusal/error preambles emitted by the vision LLM when it cannot
 * actually access the temp image file (e.g., Read tool not granted, sandbox
 * denied, or the model declines for any reason). Treating such output as a
 * caption pollutes the observation stream and looks like prompt-injection.
 */
export function isVisionRefusal(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Hard signal: the temp path leaked from our prompt back into the answer.
  if (trimmed.includes("/tmp/aria-vision")) return true;
  // Hard signal: explicit ask for permission/access.
  if (/\b(grant|give|provide)\s+(me\s+)?(access|permission|read access)\b/i.test(trimmed)) return true;
  if (/\bplease\s+(grant|enable|allow)\b/i.test(trimmed)) return true;
  // Refusal preambles at the start of the response.
  const refusalPrefixes = [
    /^i\s+don'?t\s+have\s+(the\s+)?(permission|access|ability|capability)/i,
    /^i\s+(can'?t|cannot|am\s+unable\s+to|won'?t\s+be\s+able\s+to)\s+.{0,40}\b(access|read|view|see|open|look\s+at|process)/i,
    /^i'?m\s+(unable|sorry|not\s+able)/i,
    /^sorry,?\s+i\s+(can'?t|cannot|don'?t)/i,
    /^i\s+apologize/i,
    /^as\s+an\s+ai\b/i,
    /^unfortunately,?\s+i\b/i,
  ];
  return refusalPrefixes.some((rx) => rx.test(trimmed));
}

// Runner cache — keyed by model so config changes take effect
let runner: LlmRunner | null = null;
let runnerModel: string | undefined;

function getRunner(): LlmRunner {
  const model = getBrainConfig().models?.vision;
  if (!runner || model !== runnerModel) {
    runnerModel = model;
    runner = new LlmRunner({ name: "vision", timeout: 30_000, model });
  }
  return runner;
}

/**
 * Describe an image using Claude CLI's built-in vision capability.
 * Like describeImage, but also reports WHY captioning failed so callers
 * can log diagnostics instead of dropping the reason silently.
 */
export async function describeImageDetailed(
  buffer: Buffer,
  mimetype: string,
  caption?: string,
): Promise<DescribeImageResult> {
  if (!getBrainConfig().enabled) {
    return { description: null, failureReason: "vision-disabled" };
  }

  if (buffer.length === 0) {
    log("Empty image buffer — skipping");
    return { description: null, failureReason: "empty-buffer" };
  }

  if (buffer.length > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    log(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB) — skipping`);
    return { description: null, failureReason: "image-too-large" };
  }

  // Map mimetypes to file extensions
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };

  const ext = extMap[mimetype] || "jpg";
  const tempId = randomBytes(4).toString("hex");
  const tempPath = `${TEMP_DIR}/aria-img-${tempId}.${ext}`;

  try {
    // Ensure temp directory exists
    if (!existsSync(TEMP_DIR)) {
      mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Write image to temp file
    writeFileSync(tempPath, buffer);

    const captionContext = caption ? ` The sender included this caption: "${caption}".` : "";
    const prompt = `Read the image at ${tempPath} and describe what you see in 2-3 sentences. If there is text in the image, transcribe it.${captionContext} Respond with ONLY the description, no preamble.`;

    // Use Claude CLI with Read tool access so it can view the image
    const result = await getRunner().run(prompt);

    if (!result || result.trim().length === 0) {
      log("Vision returned empty description");
      return { description: null, failureReason: "empty-result" };
    }

    const description = result.trim();
    if (isVisionRefusal(description)) {
      log(`Vision returned refusal-style text (dropping): ${description.slice(0, 120)}`);
      return {
        description: null,
        failureReason: "refusal",
        failureSnippet: description.slice(0, 120),
      };
    }
    log(`Described image (${(buffer.length / 1024).toFixed(0)}KB ${ext}) → ${description.length} chars`);
    return { description };
  } catch (err) {
    log(`Image description failed: ${err}`);
    return {
      description: null,
      failureReason: "exception",
      failureSnippet: String(err).slice(0, 120),
    };
  } finally {
    // Clean up temp file
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Non-critical cleanup failure
    }
  }
}

/**
 * Describe an image using Claude CLI's built-in vision capability.
 * Returns a text description, or null on failure.
 */
export async function describeImage(
  buffer: Buffer,
  mimetype: string,
  caption?: string,
): Promise<string | null> {
  const result = await describeImageDetailed(buffer, mimetype, caption);
  return result.description;
}
