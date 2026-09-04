/**
 * Public HTTP endpoints for Home Assistant.
 *
 *   POST /homeassistant/event      house → ARIA: one event, answered with the reflex result
 *   GET  /homeassistant/commands   house ← ARIA: pull queued service calls
 *
 * Both are protected by the shared webhook token (X-ARIA-Token header or
 * Bearer token) and a per-token request budget, independent of the web
 * dashboard's session auth.
 */

import { IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { createLogger } from "../logger.js";
import { respondJson } from "../utils/api-helpers.js";
import { parseHAEvent, bufferEvent } from "./ha-events.js";
import type { HAEvent } from "./ha-events.js";
import { pullQueuedCommands } from "./ha-commands.js";
import { getWebhookToken } from "./homeassistant.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { runReflexForEvent } from "../ha-reflexes.js";
import type { ReflexResult } from "../ha-reflexes.js";

const log = createLogger("ha-webhook");

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 10_000;
/** Requests per minute the house may make in total (events + pulls). */
export const WEBHOOK_RATE_LIMIT = 200;

// ── Auth ──

export function extractToken(req: IncomingMessage): string {
  const header = req.headers["x-aria-token"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return "";
}

export function tokensMatch(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

let windowStart = 0;
let windowCount = 0;

export function consumeRateBudget(now: number = Date.now()): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount <= WEBHOOK_RATE_LIMIT;
}

function authorize(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isIntegrationEnabled("homeassistant")) {
    respondJson(res, 503, { error: "Home Assistant integration is disabled" });
    return false;
  }
  if (!tokensMatch(extractToken(req), getWebhookToken())) {
    log("Rejected request: bad or missing webhook token");
    respondJson(res, 401, { error: "Unauthorized" });
    return false;
  }
  if (!consumeRateBudget()) {
    respondJson(res, 429, { error: "Too many requests" });
    return false;
  }
  return true;
}

function readLimitedBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("body timeout"));
    }, BODY_TIMEOUT_MS);
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("payload too large"));
        }
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(body);
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Event intake ──

export interface EventResponse {
  ok: true;
  eventId: string;
  buffered: string;
  reflex: null | {
    id: string;
    speak?: string;
    tts?: ReflexResult["tts"];
    audioUrl?: string | null;
    voiceProvider?: ReflexResult["voiceProvider"];
    delivery: ReflexResult["delivery"];
    durationMs: number;
  };
}

/** Reflex first (so HA gets its answer), then buffer for the digest with the outcome attached. */
export async function processInboundEvent(event: HAEvent, now: Date = new Date()): Promise<EventResponse> {
  const reflex = await runReflexForEvent(event, now);
  const outcome = bufferEvent(event, reflex ? { by: reflex.reflexId, summary: reflex.summary } : undefined);
  return {
    ok: true,
    eventId: event.id,
    buffered: outcome,
    reflex: reflex
      ? { id: reflex.reflexId, speak: reflex.speak, tts: reflex.tts, audioUrl: reflex.audioUrl ?? null, voiceProvider: reflex.voiceProvider, delivery: reflex.delivery, durationMs: reflex.durationMs }
      : null,
  };
}

export async function handleHAEventWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorize(req, res)) return;

  let raw: string;
  try {
    raw = await readLimitedBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respondJson(res, message === "payload too large" ? 413 : 400, { error: message });
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw || "{}");
  } catch {
    respondJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const parsed = parseHAEvent(json);
  if (!parsed.ok) {
    log(`Rejected event: ${parsed.error}`);
    respondJson(res, 400, { error: parsed.error });
    return;
  }

  try {
    const response = await processInboundEvent(parsed.event);
    respondJson(res, 200, response);
  } catch (err) {
    log(`Event processing failed: ${err}`);
    respondJson(res, 500, { error: "Event processing failed" });
  }
}

// ── Command pull ──

export function handleHACommandsPull(req: IncomingMessage, res: ServerResponse): void {
  if (!authorize(req, res)) return;
  try {
    respondJson(res, 200, { commands: pullQueuedCommands() });
  } catch (err) {
    log(`Command pull failed: ${err}`);
    respondJson(res, 500, { error: "Command pull failed" });
  }
}
