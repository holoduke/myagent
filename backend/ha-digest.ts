/**
 * Home Assistant event digest — the slow, cheap path into the brain.
 *
 * Every `digestIntervalMs` the buffered house events are drained and folded
 * into ONE observation. Small batches are summarized by a template; larger
 * ones get a single cheap-model pass. The observation then rides the normal
 * think tick, where the capable model decides whether anything deserves a
 * reaction (a message, a memory, a command back to the house).
 */

import { LlmRunner } from "./providers/llm-runner.js";
import { getBrainConfig } from "./brain-config.js";
import { recordObservation } from "./observer.js";
import { isIntegrationEnabled } from "./integrations/integration-config.js";
import { drainEvents, describeEvent, getPendingCount } from "./integrations/ha-events.js";
import type { HAEventRecord } from "./integrations/ha-events.js";
import { loadConfig } from "./integrations/homeassistant.js";
import { createLogger } from "./logger.js";

const log = createLogger("ha-digest");

/** Batches up to this size are summarized without a model call. */
export const TEMPLATE_MAX_EVENTS = 4;
const MAX_EVENTS_TO_LLM = 80;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
const LLM_TIMEOUT_MS = 45_000;

function formatTime(ts: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

export function formatEventLine(event: HAEventRecord, timezone: string): string {
  const base = `${formatTime(event.ts, timezone)} ${describeEvent(event)}`;
  return event.handledBy ? `${base} → ARIA ${event.handledSummary ?? `handled via ${event.handledBy}`}` : base;
}

/** Deterministic summary for small batches: one line per event. */
export function buildTemplateDigest(events: HAEventRecord[], timezone: string): string {
  return events.map(e => `- ${formatEventLine(e, timezone)}`).join("\n");
}

export function buildDigestPrompt(events: HAEventRecord[], dropped: number, timezone: string): string {
  const lines = events.slice(0, MAX_EVENTS_TO_LLM).map(e => formatEventLine(e, timezone));
  const droppedNote = dropped > 0 ? `\n(${dropped} further events were dropped by the flood guard.)` : "";
  return `You summarize smart-home events for a personal assistant's memory. Below are Home Assistant events from the last batch (owner-local times). Lines ending in "→ ARIA ..." were already handled in real time.

EVENTS:
${lines.join("\n")}${droppedNote}

Write a compact digest of what happened in the house. Rules:
- 1–6 bullets, one line each, no preamble, no sign-off.
- Group repetitive sensor chatter into one bullet with counts and a time range.
- Keep anything a person did (button presses, doors, presence) and anything unusual (device unavailable, unexpected times) as its own bullet.
- Mention what ARIA already did so it is not repeated.
- Plain factual language. Output only the bullets.`;
}

export interface HADigestResult {
  eventCount: number;
  dropped: number;
  recorded: boolean;
  usedLLM: boolean;
  summary: string | null;
}

function windowLabel(events: HAEventRecord[], timezone: string): string {
  const first = events[0]?.ts ?? Date.now();
  const last = events[events.length - 1]?.ts ?? first;
  return `${formatTime(first, timezone)}–${formatTime(last, timezone)}`;
}

/**
 * Drain the buffer and record one observation. Never throws; on LLM failure
 * the template summary is used so events are never lost.
 */
export async function runHADigest(now: Date = new Date()): Promise<HADigestResult> {
  if (!isIntegrationEnabled("homeassistant")) {
    return { eventCount: 0, dropped: 0, recorded: false, usedLLM: false, summary: null };
  }
  const { events, dropped } = drainEvents(now.getTime());
  if (events.length === 0 && dropped === 0) {
    return { eventCount: 0, dropped: 0, recorded: false, usedLLM: false, summary: null };
  }

  const timezone = getBrainConfig().ownerTimezone;
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  let summary: string | null = null;
  let usedLLM = false;

  if (sorted.length > TEMPLATE_MAX_EVENTS) {
    const runner = new LlmRunner({
      name: "ha-digest",
      timeout: LLM_TIMEOUT_MS,
      model: getBrainConfig().models?.haDigest ?? "haiku",
    });
    try {
      const raw = await runner.run(buildDigestPrompt(sorted, dropped, timezone));
      if (raw && raw.trim()) {
        summary = raw.trim();
        usedLLM = true;
      }
    } catch (err) {
      log(`Digest LLM failed, using template: ${err}`);
    }
  }
  if (!summary) {
    summary = buildTemplateDigest(sorted, timezone);
    if (dropped > 0) summary += `\n- ${dropped} further events dropped by the flood guard`;
  }

  const eventCount = sorted.length;
  const header = eventCount > 0 ? `[HOME DIGEST ${windowLabel(sorted, timezone)}, ${eventCount} events]` : `[HOME DIGEST] ${dropped} events dropped by the flood guard`;
  try {
    recordObservation({
      timestamp: now.getTime(),
      sender: "Home Assistant",
      senderJid: "ha:digest",
      isGroup: false,
      isFromMe: false,
      text: `${header}\n${summary}`,
      source: "homeassistant",
      trustLevel: "trusted",
    });
  } catch (err) {
    log(`Failed to record digest observation: ${err}`);
    return { eventCount, dropped, recorded: false, usedLLM, summary };
  }

  log(`Digest recorded: ${eventCount} events${dropped ? `, ${dropped} dropped` : ""}${usedLLM ? " (llm)" : " (template)"}`);
  return { eventCount, dropped, recorded: true, usedLLM, summary };
}

// ── Loop ──

let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runHADigest();
  } catch (err) {
    log(`Digest tick error: ${err}`);
  } finally {
    running = false;
  }
}

export function startHADigestLoop(): void {
  stopHADigestLoop();
  const config = loadConfig();
  const interval = config?.digestIntervalMs ?? 15 * 60 * 1000;
  log(`Starting Home Assistant digest loop (every ${Math.round(interval / 60000)} min, ${getPendingCount()} pending)`);
  firstRun = setTimeout(() => { void tick(); }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => { void tick(); }, interval);
}

export function stopHADigestLoop(): void {
  if (firstRun) { clearTimeout(firstRun); firstRun = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

export function restartHADigestLoop(): void {
  startHADigestLoop();
}
