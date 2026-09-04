/**
 * Home Assistant integration — configuration, status and (optional) state polling.
 *
 * Two directions:
 *   house → ARIA  events pushed to POST /homeassistant/event (ha-webhook.ts),
 *                 buffered (ha-events.ts), answered by reflexes (ha-reflexes.ts)
 *                 and digested into the brain (ha-digest.ts)
 *   ARIA → house  service calls through ha-client.ts when the house is reachable,
 *                 otherwise queued for the house to pull (ha-commands.ts)
 *
 * Polling of entity states is optional and only used when a direct/cloud URL
 * is configured; its changes go through the same buffer as pushed events.
 */

import { randomBytes } from "crypto";
import { FileStore } from "../utils/file-store.js";
import { isIntegrationEnabled } from "./integration-config.js";
import { createLogger } from "../logger.js";
import { bufferEvent, getPendingCount, getLastDigestAt, getRecentEvents, HA_DIR } from "./ha-events.js";
import type { HAEventRecord } from "./ha-events.js";
import { getQueuedCount } from "./ha-commands.js";

const log = createLogger("homeassistant");

const CONFIG_FILE = `${HA_DIR}/config.json`;
const STATE_FILE = `${HA_DIR}/state.json`;
const DEFAULT_ENTITIES = ["light", "switch", "lock", "climate", "binary_sensor", "sensor"];
const DEFAULT_POLL_INTERVAL = 60_000;
const DEFAULT_DIGEST_INTERVAL = 15 * 60 * 1000;
/** Rijnsburg, NL — overridable in config. */
const DEFAULT_LOCATION = { lat: 52.19, lon: 4.49 };

// ── Types ──

/** "webhook": house pushes only (no outbound URL). Others add a reachable URL for direct calls. */
export type HAConnectionMode = "webhook" | "direct_api" | "cloud";

export interface HADirectApiConfig {
  url: string;   // e.g. "http://192.168.1.100:8123" or a port-forwarded/VPN address
  token: string; // Long-lived access token
}

export interface HACloudConfig {
  url: string;   // e.g. "https://xxxxxxxx.ui.nabu.casa"
  token: string;
}

export interface HAWeatherReflexConfig {
  enabled: boolean;
  /** Device / friendly name / entity id of the button, as sent by Home Assistant. */
  device: string;
  /** Button actions that trigger the briefing (Zigbee2MQTT action names). */
  actions: string[];
  /** media_player entity that speaks the briefing. */
  mediaPlayer: string;
  /** "google_translate" | "cloud" (legacy *_say services) or a "tts.*" entity for tts.speak. */
  ttsEngine: string;
  language: string;
  /** Owner-local hour from which the briefing covers tomorrow instead of today. */
  eveningHour: number;
  /** Weather entity used when ARIA can reach Home Assistant directly. */
  weatherEntity: string;
  /** Also push the TTS call from the server (in addition to the HTTP response). */
  pushTts: boolean;
  /** Speaker volume (0–1) set right before ARIA speaks; null leaves the volume alone. */
  ttsVolume: number | null;
}

export interface HAConfig {
  mode: HAConnectionMode;
  direct_api?: HADirectApiConfig;
  cloud?: HACloudConfig;
  entities: string[];       // Entity domains to monitor when polling
  pollInterval: number;     // ms between polls
  /** Shared secret Home Assistant sends with every request. */
  webhookToken: string;
  digestIntervalMs: number;
  location: { lat: number; lon: number };
  reflexes: {
    weatherBriefing: HAWeatherReflexConfig;
  };
}

interface EntityState {
  entity_id: string;
  state: string;
  attributes: { friendly_name?: string; [key: string]: unknown };
  last_changed: string;
}

interface HAState {
  lastPoll: number;
  entities: Record<string, string>; // entity_id → last known state
}

// ── Defaults ──

export const DEFAULT_WEATHER_REFLEX: HAWeatherReflexConfig = {
  enabled: true,
  device: "Ikea switch 3 silver",
  actions: ["on", "off", "arrow_left_click", "arrow_right_click"],
  mediaPlayer: "media_player.wiim_amp_ultra_3d72",
  ttsEngine: "google_translate",
  language: "nl",
  eveningHour: 14,
  weatherEntity: "weather.buienradar",
  pushTts: false,
  ttsVolume: 0.3,
};

export function generateWebhookToken(): string {
  return randomBytes(24).toString("base64url");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Fill in defaults for older/partial config files so every field is present. */
export function withDefaults(partial: Partial<HAConfig> | null | undefined): HAConfig {
  const reflex = { ...DEFAULT_WEATHER_REFLEX, ...(partial?.reflexes?.weatherBriefing ?? {}) };
  return {
    mode: partial?.mode ?? "webhook",
    direct_api: partial?.direct_api,
    cloud: partial?.cloud,
    entities: Array.isArray(partial?.entities) && partial.entities.length > 0 ? partial.entities : DEFAULT_ENTITIES,
    pollInterval: clampNumber(partial?.pollInterval, DEFAULT_POLL_INTERVAL, 15_000, 3_600_000),
    webhookToken: typeof partial?.webhookToken === "string" ? partial.webhookToken : "",
    digestIntervalMs: clampNumber(partial?.digestIntervalMs, DEFAULT_DIGEST_INTERVAL, 60_000, 6 * 3_600_000),
    location: {
      lat: clampNumber(partial?.location?.lat, DEFAULT_LOCATION.lat, -90, 90),
      lon: clampNumber(partial?.location?.lon, DEFAULT_LOCATION.lon, -180, 180),
    },
    reflexes: {
      weatherBriefing: {
        ...reflex,
        actions: Array.isArray(reflex.actions) ? reflex.actions.filter(a => typeof a === "string" && a) : DEFAULT_WEATHER_REFLEX.actions,
        eveningHour: clampNumber(reflex.eveningHour, DEFAULT_WEATHER_REFLEX.eveningHour, 0, 23),
        ttsVolume: reflex.ttsVolume === null ? null : clampNumber(reflex.ttsVolume, DEFAULT_WEATHER_REFLEX.ttsVolume ?? 0.3, 0, 1),
      },
    },
  };
}

// ── Persistence ──

const configStore = new FileStore<Partial<HAConfig> | null>({ filePath: CONFIG_FILE, defaultValue: null });
const haStateStore = new FileStore<HAState>({ filePath: STATE_FILE, defaultValue: { lastPoll: 0, entities: {} } });

/** Migrate env vars to config format (backward compat) */
function loadConfigFromEnv(): Partial<HAConfig> | null {
  const url = process.env.HA_URL || "";
  const token = process.env.HA_TOKEN || "";
  if (!url || !token) return null;
  const entities = (process.env.HA_ENTITIES || DEFAULT_ENTITIES.join(",")).split(",").map(s => s.trim());
  return { mode: "direct_api", direct_api: { url, token }, entities, pollInterval: Number(process.env.HA_POLL_INTERVAL ?? DEFAULT_POLL_INTERVAL) };
}

/** Always returns a usable config: webhook mode with defaults when nothing was saved yet. */
export function loadConfig(): HAConfig {
  return withDefaults(configStore.load() || loadConfigFromEnv());
}

export function saveConfig(config: Partial<HAConfig>): HAConfig {
  const merged = withDefaults({ ...loadConfig(), ...config });
  configStore.save(merged);
  log(`Config saved (mode: ${merged.mode})`);
  return merged;
}

/** Make sure a webhook token exists (first boot) and return it. */
export function ensureWebhookToken(): string {
  const config = loadConfig();
  if (config.webhookToken) return config.webhookToken;
  const token = generateWebhookToken();
  saveConfig({ webhookToken: token });
  log("Generated Home Assistant webhook token");
  return token;
}

export function getWebhookToken(): string {
  return loadConfig().webhookToken;
}

export function regenerateWebhookToken(): string {
  const token = generateWebhookToken();
  saveConfig({ webhookToken: token });
  log("Regenerated Home Assistant webhook token — update the house automation");
  return token;
}

/** Public base URL of this agent, for the dashboard's copy-paste webhook URL. */
export function getPublicBaseUrl(): string {
  return (process.env.PUBLIC_URL || process.env.COOLIFY_URL || "").replace(/\/+$/, "");
}

/** Get active URL and token for outbound calls; null in webhook-only mode. */
export function getActiveConnection(config: HAConfig): { url: string; token: string } | null {
  if (config.mode === "direct_api" && config.direct_api?.url && config.direct_api?.token) {
    return { url: config.direct_api.url.replace(/\/+$/, ""), token: config.direct_api.token };
  }
  if (config.mode === "cloud" && config.cloud?.url && config.cloud?.token) {
    return { url: config.cloud.url.replace(/\/+$/, ""), token: config.cloud.token };
  }
  return null;
}

// ── Polling (only when the house is reachable) ──

function matchesEntityFilter(entityId: string, entities: string[]): boolean {
  const domain = entityId.split(".")[0];
  return entities.includes(domain || "");
}

async function pollHA(): Promise<void> {
  if (!isIntegrationEnabled("homeassistant")) return;
  const config = loadConfig();
  const conn = getActiveConnection(config);
  if (!conn) return;

  try {
    const state = haStateStore.load();
    const res = await fetch(`${conn.url}/api/states`, {
      headers: { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log(`HA API returned ${res.status}: ${res.statusText} (mode: ${config.mode})`);
      return;
    }

    const entities = await res.json() as EntityState[];
    const nextEntities: Record<string, string> = {};
    let changedCount = 0;
    const now = Date.now();

    for (const entity of entities) {
      if (!matchesEntityFilter(entity.entity_id, config.entities)) continue;
      const previousState = state.entities[entity.entity_id];
      if (previousState !== undefined && previousState !== entity.state) {
        bufferEvent({
          id: `hae_poll_${now}_${changedCount}`,
          receivedAt: now,
          ts: Date.parse(entity.last_changed) || now,
          type: "state_change",
          entityId: entity.entity_id,
          friendlyName: entity.attributes.friendly_name,
          state: entity.state,
          previousState,
        });
        changedCount++;
      }
      nextEntities[entity.entity_id] = entity.state;
    }

    haStateStore.save({ lastPoll: now, entities: nextEntities });
    if (changedCount > 0) log(`Buffered ${changedCount} entity state changes`);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      log(`HA poll timed out after 15s (mode: ${config.mode}) — server may be unreachable`);
    } else {
      log(`HA poll failed (mode: ${config.mode}): ${err}`);
    }
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startHAPolling(): void {
  const config = loadConfig();
  const conn = getActiveConnection(config);
  if (!conn) {
    log(`Home Assistant in ${config.mode} mode — no outbound polling (events arrive via webhook)`);
    return;
  }
  log(`Starting Home Assistant polling (mode: ${config.mode}, every ${config.pollInterval / 1000}s)`);
  setTimeout(() => pollHA(), 8000);
  pollTimer = setInterval(() => pollHA(), config.pollInterval);
}

export function stopHAPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Home Assistant polling stopped");
  }
}

export function restartHAPolling(): void {
  stopHAPolling();
  startHAPolling();
}

// ── Status ──

export interface HAStatusResponse {
  enabled: boolean;
  /** Outbound direction: ARIA can call the house directly. */
  connected: boolean;
  /** Inbound direction: the house has pushed at least one event. */
  receiving: boolean;
  mode: HAConnectionMode;
  url: string;
  webhookUrl: string;
  webhookToken: string;
  entityCount: number;
  lastPoll: number;
  lastEventAt: number;
  eventsToday: number;
  pendingDigest: number;
  lastDigestAt: number;
  queuedCommands: number;
  recentEvents: HAEventRecord[];
  config: HAConfig;
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getHAStatus(): HAStatusResponse {
  const config = loadConfig();
  const conn = getActiveConnection(config);
  const state = haStateStore.load();
  const recent = getRecentEvents(200);
  const todayStart = startOfTodayMs();
  const base = getPublicBaseUrl();

  return {
    enabled: isIntegrationEnabled("homeassistant"),
    connected: !!(conn && state.lastPoll > 0),
    receiving: recent.length > 0,
    mode: config.mode,
    url: conn?.url || "",
    webhookUrl: base ? `${base}/homeassistant/event` : "/homeassistant/event",
    webhookToken: config.webhookToken,
    entityCount: Object.keys(state.entities).length,
    lastPoll: state.lastPoll,
    lastEventAt: recent[0]?.receivedAt ?? 0,
    eventsToday: recent.filter(e => e.receivedAt >= todayStart).length,
    pendingDigest: getPendingCount(),
    lastDigestAt: getLastDigestAt(),
    queuedCommands: getQueuedCount(),
    recentEvents: recent.slice(0, 25),
    config: {
      ...config,
      direct_api: config.direct_api ? { ...config.direct_api, token: config.direct_api.token ? "***" : "" } : undefined,
      cloud: config.cloud ? { ...config.cloud, token: config.cloud.token ? "***" : "" } : undefined,
    },
  };
}
