/**
 * Prompt-based actionable content detection.
 *
 * Replaces regex patterns with a lightweight Claude call (haiku)
 * for whitelisted contacts. The detection prompt is configurable
 * via brain config and editable from the dashboard.
 */

import { BaseProvider } from "./providers/base-provider.js";
import { createLogger } from "./logger.js";
import { getBrainConfig } from "./brain-config.js";

const log = createLogger("prompt-detector");

export interface DetectedEvent {
  summary: string;
  date: string;        // ISO date string YYYY-MM-DD
  time: string | null;  // HH:MM or null
  location: string | null;
  endTime: string | null;
}

export interface DetectedRequest {
  action: string;
  urgency: "low" | "medium" | "high";
}

export interface PromptDetectionResult {
  events: DetectedEvent[];
  requests: DetectedRequest[];
  raw?: string;
}

const DEFAULT_DETECTION_PROMPT = `You are an event detection system for a Dutch family. Analyze the incoming message and extract any actionable items.

Rules:
- Accept incoming events when they mention: dates, holidays, appointments, gatherings, birthdays, dinners, parties, school events, family meetups, deadlines, or any time-bound activity.
- Understand Dutch holidays: Pasen (Easter), Pinksteren (Whitsun), Kerst (Christmas), Koningsdag (Apr 27), Hemelvaart (Ascension), Bevrijdingsdag (May 5). Calculate actual dates for the current year.
- Understand informal Dutch time references: "rond" (around), "ongeveer" (approximately), "omstreeks" (around), "tegen" (by/around), "na" (after), "voor" (before).
- Understand relative dates: "morgen", "overmorgen", "volgende week", "komend weekend", day names.
- If a message contains MULTIPLE events, extract each one separately.
- If no actionable content is found, return empty arrays.

Current date: {today}

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{"events":[{"summary":"short description","date":"YYYY-MM-DD","time":"HH:MM or null","location":"location or null","endTime":"HH:MM or null"}],"requests":[{"action":"what is being asked","urgency":"low|medium|high"}]}`;

/**
 * Detect actionable content using a Claude prompt.
 * Uses haiku model for cost efficiency (~0.001 per call).
 */
export async function detectWithPrompt(
  text: string,
  senderName: string,
): Promise<PromptDetectionResult> {
  const config = getBrainConfig();
  const promptTemplate = config.detectionPrompt || DEFAULT_DETECTION_PROMPT;

  // Fill in template variables
  const today = new Date().toISOString().slice(0, 10);
  const prompt = promptTemplate
    .replace("{today}", today)
    .replace("{sender}", senderName);

  const fullPrompt = `${prompt}\n\nMessage from ${senderName}:\n"${text}"`;

  try {
    const detector = new PromptDetectorProvider();
    const result = await detector.run(fullPrompt);

    if (!result) {
      log(`No result from prompt detector for: "${text.slice(0, 60)}"`);
      return { events: [], requests: [] };
    }

    // Parse JSON from response - handle potential markdown wrapping
    const jsonStr = result.replace(/^```json?\s*/, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(jsonStr) as PromptDetectionResult;

    // Validate structure
    if (!Array.isArray(parsed.events)) parsed.events = [];
    if (!Array.isArray(parsed.requests)) parsed.requests = [];

    // Validate each event has required fields
    parsed.events = parsed.events.filter(e => e.summary && e.date);

    log(`Prompt detector found ${parsed.events.length} events, ${parsed.requests.length} requests in: "${text.slice(0, 60)}"`);
    return parsed;
  } catch (err: any) {
    log(`Prompt detection failed: ${err.message || err}`);
    return { events: [], requests: [] };
  }
}

/**
 * Lightweight provider that spawns claude CLI with haiku model.
 * No session, no tools — just a single prompt -> JSON response.
 */
class PromptDetectorProvider extends BaseProvider {
  readonly name = "prompt-detector";
  readonly supportsStreaming = false;
  readonly supportsSessions = false;

  /* eslint-disable @typescript-eslint/no-unused-vars */
  async ask(_message: string) { return { messages: [] as string[] }; }
  async askStreaming(_message: string, _onDelta: (text: string) => void) { return { messages: [] as string[] }; }
  resetSession() { /* no-op */ }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  async run(prompt: string): Promise<string | null> {
    const timeout = 30_000; // 30s max for detection

    return new Promise((resolve) => {
      const { promise } = this.spawnWithTimeout({
        command: "claude",
        args: [
          "-p", prompt,
          "--output-format", "json",
          "--model", "haiku",
          "--allowedTools", "",  // no tools needed
        ],
        env: {
          ANTHROPIC_API_KEY: "",
          CLAUDECODE: "",
          HOME: process.env.CLAUDE_HOME || process.env.HOME || "/root",
        },
        timeout,
        onTimeout: () => {
          log("Prompt detector timed out");
        },
      });

      promise.then(({ code, stdout, stderr }) => {
        if (code !== 0) {
          log(`Prompt detector exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
          return;
        }

        try {
          const response = JSON.parse(stdout) as { result: string; is_error: boolean };
          if (response.is_error) {
            log(`Prompt detector error: ${response.result.slice(0, 200)}`);
            resolve(null);
            return;
          }
          resolve(response.result);
        } catch {
          // Try raw stdout
          resolve(stdout.trim() || null);
        }
      }).catch((err) => {
        log(`Prompt detector spawn failed: ${err}`);
        resolve(null);
      });
    });
  }
}

export function getDefaultDetectionPrompt(): string {
  return DEFAULT_DETECTION_PROMPT;
}
