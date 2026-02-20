import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";

// ── Types ──

export interface BrainConfig {
  enabled: boolean;
  maxMessagesPerDay: number;
  minMessageInterval: number;   // ms
  quietStart: number;           // hour 0-23
  quietEnd: number;             // hour 0-23
  thinkCooldown: number;        // ms
  consolidateInterval: number;  // ms
  reflectInterval: number;      // ms
  tickInterval: number;         // ms
  preset: string | null;        // preset name or null for custom
}

export interface BrainPreset {
  name: string;
  label: string;
  description: string;
  values: Partial<BrainConfig>;
}

// ── Presets ──

export const BRAIN_PRESETS: BrainPreset[] = [
  {
    name: "silent",
    label: "Silent",
    description: "No proactive messages. ARIA thinks but never reaches out.",
    values: {
      enabled: true,
      maxMessagesPerDay: 0,
      minMessageInterval: 86400000,  // 24h
      quietStart: 0,
      quietEnd: 24,
    },
  },
  {
    name: "quiet",
    label: "Quiet",
    description: "Up to 2 messages/day, 4h minimum gap, quiet 22:00-09:00.",
    values: {
      enabled: true,
      maxMessagesPerDay: 2,
      minMessageInterval: 14400000,  // 4h
      quietStart: 22,
      quietEnd: 9,
    },
  },
  {
    name: "normal",
    label: "Normal",
    description: "Up to 5 messages/day, 2h gap, quiet 23:00-07:00. Default behavior.",
    values: {
      enabled: true,
      maxMessagesPerDay: 5,
      minMessageInterval: 7200000,   // 2h
      quietStart: 23,
      quietEnd: 7,
    },
  },
  {
    name: "active",
    label: "Active",
    description: "Up to 10 messages/day, 1h gap, no quiet hours.",
    values: {
      enabled: true,
      maxMessagesPerDay: 10,
      minMessageInterval: 3600000,   // 1h
      quietStart: 0,
      quietEnd: 0,
    },
  },
];

// ── Defaults from env vars ──

function envDefaults(): BrainConfig {
  return {
    enabled: process.env.BRAIN_ENABLED !== "false",
    maxMessagesPerDay: Number(process.env.BRAIN_MAX_MESSAGES_PER_DAY ?? 5),
    minMessageInterval: Number(process.env.BRAIN_MIN_MESSAGE_INTERVAL ?? 7200000),
    quietStart: Number(process.env.BRAIN_QUIET_START ?? 23),
    quietEnd: Number(process.env.BRAIN_QUIET_END ?? 7),
    thinkCooldown: Number(process.env.BRAIN_THINK_COOLDOWN ?? 300000),
    consolidateInterval: Number(process.env.BRAIN_CONSOLIDATE_INTERVAL ?? 14400000),
    reflectInterval: Number(process.env.BRAIN_REFLECT_INTERVAL ?? 43200000),
    tickInterval: Number(process.env.BRAIN_TICK_INTERVAL ?? 60000),
    preset: null,
  };
}

// ── Config file path ──

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const CONFIG_FILE = `${BRAIN_DIR}/config.json`;

// ── In-memory cache (5s TTL) ──

let cachedConfig: BrainConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 5000;

// ── Public API ──

export function getBrainConfig(): BrainConfig {
  const now = Date.now();
  if (cachedConfig && (now - cacheTime) < CACHE_TTL) {
    return cachedConfig;
  }

  const defaults = envDefaults();

  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      const saved = JSON.parse(raw) as Partial<BrainConfig>;
      cachedConfig = { ...defaults, ...saved };
    } else {
      cachedConfig = defaults;
    }
  } catch {
    cachedConfig = defaults;
  }

  cacheTime = now;
  return cachedConfig;
}

export function saveBrainConfig(partial: Partial<BrainConfig>): BrainConfig {
  const current = getBrainConfig();
  const updated = { ...current, ...partial };

  try {
    if (!existsSync(BRAIN_DIR)) {
      mkdirSync(BRAIN_DIR, { recursive: true });
    }
    const tmp = CONFIG_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(updated, null, 2));
    renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    throw new Error(`Failed to save brain config: ${err}`);
  }

  // Invalidate cache
  cachedConfig = updated;
  cacheTime = Date.now();

  return updated;
}

export function getActivePreset(config: BrainConfig): string | null {
  if (config.preset) return config.preset;

  // Auto-detect matching preset
  for (const preset of BRAIN_PRESETS) {
    const v = preset.values;
    const matches =
      (v.maxMessagesPerDay === undefined || v.maxMessagesPerDay === config.maxMessagesPerDay) &&
      (v.minMessageInterval === undefined || v.minMessageInterval === config.minMessageInterval) &&
      (v.quietStart === undefined || v.quietStart === config.quietStart) &&
      (v.quietEnd === undefined || v.quietEnd === config.quietEnd);
    if (matches) return preset.name;
  }

  return null;
}
