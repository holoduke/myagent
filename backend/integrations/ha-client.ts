/**
 * Home Assistant outbound client — the agent → house direction.
 *
 * Only works when Home Assistant is reachable from the server (direct URL,
 * Nabu Casa cloud URL, or a VPN). When it is not, callers fall back to the
 * pull queue in ha-commands.ts, which Home Assistant drains itself.
 */

import { createLogger } from "../logger.js";
import { loadConfig, getActiveConnection } from "./homeassistant.js";
import type { HAConfig } from "./homeassistant.js";

const log = createLogger("ha-client");

const REQUEST_TIMEOUT_MS = 15_000;

export interface HAConnection {
  url: string;
  token: string;
}

export interface HAEntityState {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; [key: string]: unknown };
  last_changed: string;
}

export interface ServiceCall {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  /** Target entity id(s); merged into the payload as entity_id. */
  entityId?: string | string[];
}

export class HAClientError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "HAClientError";
  }
}

/** Resolve the active connection, or null when the agent cannot reach Home Assistant. */
export function resolveConnection(config: HAConfig | null = loadConfig()): HAConnection | null {
  if (!config) return null;
  return getActiveConnection(config);
}

export function isHAReachableConfigured(): boolean {
  return resolveConnection() !== null;
}

async function request<T>(conn: HAConnection, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${conn.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${conn.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof DOMException && err.name === "TimeoutError" ? "timed out" : String(err);
    throw new HAClientError(`Home Assistant request ${path} failed: ${reason}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HAClientError(`Home Assistant ${path} returned ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** All entity states, optionally filtered by domain (e.g. "light"). */
export async function getStates(domain?: string, conn: HAConnection | null = resolveConnection()): Promise<HAEntityState[]> {
  if (!conn) throw new HAClientError("Home Assistant is not reachable from the agent (no direct/cloud URL configured)");
  const states = await request<HAEntityState[]>(conn, "/api/states");
  return domain ? states.filter(s => s.entity_id.startsWith(`${domain}.`)) : states;
}

export function buildServicePayload(call: ServiceCall): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...(call.data || {}) };
  if (call.entityId) payload.entity_id = call.entityId;
  return payload;
}

/** Call a Home Assistant service. Returns the service response when requested. */
export async function callService(
  call: ServiceCall,
  opts: { returnResponse?: boolean; conn?: HAConnection | null } = {},
): Promise<unknown> {
  const conn = opts.conn === undefined ? resolveConnection() : opts.conn;
  if (!conn) throw new HAClientError("Home Assistant is not reachable from the agent (no direct/cloud URL configured)");
  const query = opts.returnResponse ? "?return_response" : "";
  const result = await request<unknown>(conn, `/api/services/${call.domain}/${call.service}${query}`, {
    method: "POST",
    body: JSON.stringify(buildServicePayload(call)),
  });
  log(`Called ${call.domain}.${call.service}${call.entityId ? ` on ${call.entityId}` : ""}`);
  return result;
}

/** Daily forecast entries from a weather entity via weather.get_forecasts. */
export async function getDailyForecast(weatherEntity: string, conn: HAConnection | null = resolveConnection()): Promise<unknown[]> {
  const response = await callService(
    { domain: "weather", service: "get_forecasts", entityId: weatherEntity, data: { type: "daily" } },
    { returnResponse: true, conn },
  ) as { service_response?: Record<string, { forecast?: unknown[] }> } | null;
  return response?.service_response?.[weatherEntity]?.forecast ?? [];
}

/** Build the TTS service call for a given engine/player, without sending it. */
export function buildTtsCall(text: string, opts: { player: string; engine: string; language: string }): ServiceCall {
  if (opts.engine.startsWith("tts.")) {
    return {
      domain: "tts",
      service: "speak",
      entityId: opts.engine,
      data: { media_player_entity_id: opts.player, message: text, language: opts.language },
    };
  }
  return {
    domain: "tts",
    service: `${opts.engine}_say`,
    entityId: opts.player,
    data: { message: text, language: opts.language },
  };
}

export async function testHAConnection(url: string, token: string): Promise<{ success: boolean; entityCount?: number; error?: string }> {
  try {
    const states = await getStates(undefined, { url: url.replace(/\/+$/, ""), token });
    return { success: true, entityCount: states.length };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
