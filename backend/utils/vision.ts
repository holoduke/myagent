/**
 * Image understanding using Claude CLI with built-in vision.
 * Reuses the HaikuRunner pattern — spawns `claude -p ... --model haiku`.
 * Saves image to temp file, asks Claude to read & describe it.
 * Cost: ~$0.0004/image via Haiku.
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { HaikuRunner } from "../providers/haiku-runner.js";
import { createLogger } from "../logger.js";

const log = createLogger("vision");

const TEMP_DIR = "/tmp/aria-vision";
const MAX_IMAGE_SIZE_MB = 10;

// Singleton runner
let runner: HaikuRunner | null = null;

function getRunner(): HaikuRunner {
  if (!runner) {
    runner = new HaikuRunner({ name: "vision", timeout: 30_000 });
  }
  return runner;
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
  if (buffer.length === 0) {
    log("Empty image buffer — skipping");
    return null;
  }

  if (buffer.length > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    log(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB) — skipping`);
    return null;
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
      return null;
    }

    const description = result.trim();
    log(`Described image (${(buffer.length / 1024).toFixed(0)}KB ${ext}) → ${description.length} chars`);
    return description;
  } catch (err) {
    log(`Image description failed: ${err}`);
    return null;
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
