import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";
import { recordObservation } from "./observer.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [homeassistant] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const HA_URL = process.env.HA_URL || "";
const HA_TOKEN = process.env.HA_TOKEN || "";
const HA_ENTITIES = (process.env.HA_ENTITIES || "light,switch,lock,climate,binary_sensor,sensor").split(",").map(s => s.trim());
const HA_DIR = "/data/homeassistant";
const STATE_FILE = `${HA_DIR}/state.json`;
const POLL_INTERVAL = Number(process.env.HA_POLL_INTERVAL ?? 60000);

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

function ensureDir(): void {
  if (!existsSync(HA_DIR)) {
    mkdirSync(HA_DIR, { recursive: true });
  }
}

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
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

function matchesEntityFilter(entityId: string): boolean {
  const domain = entityId.split(".")[0];
  return HA_ENTITIES.includes(domain || "");
}

async function pollHA(): Promise<void> {
  if (!HA_URL || !HA_TOKEN) return;

  const state = loadState();

  try {
    const res = await fetch(`${HA_URL}/api/states`, {
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      log(`HA API returned ${res.status}: ${res.statusText}`);
      return;
    }

    const entities: EntityState[] = await res.json() as EntityState[];
    let changedCount = 0;

    for (const entity of entities) {
      if (!matchesEntityFilter(entity.entity_id)) continue;

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
    log(`HA poll failed: ${err}`);
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startHAPolling(): void {
  if (!HA_URL || !HA_TOKEN) {
    log("Home Assistant not configured (HA_URL/HA_TOKEN missing), polling not started");
    return;
  }

  log(`Starting Home Assistant polling (every ${POLL_INTERVAL / 1000}s)`);

  setTimeout(() => pollHA(), 8000);
  pollTimer = setInterval(() => pollHA(), POLL_INTERVAL);
}

export function stopHAPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log("Home Assistant polling stopped");
  }
}

export function getHAStatus(): { enabled: boolean; connected: boolean; url: string; entityCount: number; lastPoll: number } {
  const enabled = !!(HA_URL && HA_TOKEN);
  const state = loadState();

  return {
    enabled,
    connected: enabled && state.lastPoll > 0,
    url: HA_URL,
    entityCount: Object.keys(state.entities).length,
    lastPoll: state.lastPoll,
  };
}
