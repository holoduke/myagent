import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import { recordObservation } from "../observer.js";
import { isIntegrationEnabled } from "./integration-config.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [homeassistant] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const HA_DIR = "/data/homeassistant";
const CONFIG_FILE = `${HA_DIR}/config.json`;
const STATE_FILE = `${HA_DIR}/state.json`;
const DEFAULT_ENTITIES = ["light", "switch", "lock", "climate", "binary_sensor", "sensor"];
const DEFAULT_POLL_INTERVAL = 60000;

// ── Types ──

export type HAConnectionMode = "direct_api" | "cloud";

export interface HADirectApiConfig {
  url: string;   // e.g. "http://192.168.1.100:8123" or "http://10.0.0.5:8123" (Tailscale)
  token: string; // Long-lived access token
}

export interface HACloudConfig {
  url: string;   // e.g. "https://xxxxxxxx.ui.nabu.casa"
  token: string; // Long-lived access token (same type, different instance)
}

export interface HAConfig {
  mode: HAConnectionMode;
  direct_api?: HADirectApiConfig;
  cloud?: HACloudConfig;
  entities: string[];       // Entity domains to monitor
  pollInterval: number;     // ms between polls
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

// ── Directory & File Helpers ──

function ensureDir(): void {
  if (!existsSync(HA_DIR)) {
    mkdirSync(HA_DIR, { recursive: true });
  }
}

function atomicWrite(path: string, data: string): void {
  ensureDir();
  const tmp = path + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// ── Config Management ──

function loadConfigFromFile(): HAConfig | null {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as HAConfig;
    }
  } catch (err) {
    log(`Failed to load HA config: ${err}`);
  }
  return null;
}

/** Migrate env vars to config format (backward compat) */
function loadConfigFromEnv(): HAConfig | null {
  const url = process.env.HA_URL || "";
  const token = process.env.HA_TOKEN || "";
  if (!url || !token) return null;

  const entities = (process.env.HA_ENTITIES || DEFAULT_ENTITIES.join(",")).split(",").map(s => s.trim());
  const pollInterval = Number(process.env.HA_POLL_INTERVAL ?? DEFAULT_POLL_INTERVAL);

  return {
    mode: "direct_api",
    direct_api: { url, token },
    entities,
    pollInterval,
  };
}

export function loadConfig(): HAConfig | null {
  return loadConfigFromFile() || loadConfigFromEnv();
}

export function saveConfig(config: HAConfig): HAConfig {
  atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2));
  log(`Config saved (mode: ${config.mode})`);
  return config;
}

/** Get active URL and token based on current mode */
function getActiveConnection(config: HAConfig): { url: string; token: string } | null {
  if (config.mode === "direct_api" && config.direct_api?.url && config.direct_api?.token) {
    return { url: config.direct_api.url.replace(/\/+$/, ""), token: config.direct_api.token };
  }
  if (config.mode === "cloud" && config.cloud?.url && config.cloud?.token) {
    return { url: config.cloud.url.replace(/\/+$/, ""), token: config.cloud.token };
  }
  return null;
}

// ── State Management ──

function loadState(): HAState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load HA state: ${err}`);
  }
  return { lastPoll: 0, entities: {} };
}

function saveState(state: HAState): void {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Polling ──

function matchesEntityFilter(entityId: string, entities: string[]): boolean {
  const domain = entityId.split(".")[0];
  return entities.includes(domain || "");
}

async function pollHA(): Promise<void> {
  if (!isIntegrationEnabled("homeassistant")) return;
  const config = loadConfig();
  if (!config) return;

  const conn = getActiveConnection(config);
  if (!conn) {
    log(`No valid connection for mode "${config.mode}"`);
    return;
  }

  const state = loadState();

  try {
    const res = await fetch(`${conn.url}/api/states`, {
      headers: {
        Authorization: `Bearer ${conn.token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      log(`HA API returned ${res.status}: ${res.statusText} (mode: ${config.mode})`);
      return;
    }

    const entities: EntityState[] = await res.json() as EntityState[];
    let changedCount = 0;

    for (const entity of entities) {
      if (!matchesEntityFilter(entity.entity_id, config.entities)) continue;

      const previousState = state.entities[entity.entity_id];
      if (previousState !== undefined && previousState !== entity.state) {
        const friendlyName = entity.attributes.friendly_name || entity.entity_id;
        recordObservation({
          timestamp: Date.now(),
          sender: "Home Assistant",
          senderJid: `ha:${entity.entity_id}`,
          isGroup: false,
          isFromMe: false,
          text: `[HOME] ${friendlyName} changed to ${entity.state}`,
          source: "homeassistant",
        });
        changedCount++;
      }

      state.entities[entity.entity_id] = entity.state;
    }

    state.lastPoll = Date.now();
    saveState(state);

    if (changedCount > 0) {
      log(`Recorded ${changedCount} entity state changes`);
    }
  } catch (err) {
    log(`HA poll failed (mode: ${config.mode}): ${err}`);
  }
}

// ── Lifecycle ──

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startHAPolling(): void {
  const config = loadConfig();
  if (!config) {
    log("Home Assistant not configured, polling not started");
    return;
  }

  const conn = getActiveConnection(config);
  if (!conn) {
    log(`Home Assistant configured (mode: ${config.mode}) but connection details incomplete, polling not started`);
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

// ── Status & Config API ──

export interface HAStatusResponse {
  enabled: boolean;
  connected: boolean;
  mode: HAConnectionMode | null;
  url: string;
  entityCount: number;
  lastPoll: number;
  config: HAConfig | null;
}

export function getHAStatus(): HAStatusResponse {
  const config = loadConfig();
  const conn = config ? getActiveConnection(config) : null;
  const state = loadState();

  return {
    enabled: !!(config && conn),
    connected: !!(config && conn && state.lastPoll > 0),
    mode: config?.mode || null,
    url: conn?.url || "",
    entityCount: Object.keys(state.entities).length,
    lastPoll: state.lastPoll,
    config: config ? { ...config, direct_api: config.direct_api ? { ...config.direct_api, token: "***" } : undefined, cloud: config.cloud ? { ...config.cloud, token: "***" } : undefined } : null,
  };
}

export async function testHAConnection(mode: HAConnectionMode, url: string, token: string): Promise<{ success: boolean; entityCount?: number; error?: string }> {
  try {
    const cleanUrl = url.replace(/\/+$/, "");
    const res = await fetch(`${cleanUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const entities = await res.json() as EntityState[];
    return { success: true, entityCount: entities.length };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
