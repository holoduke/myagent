import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";

const CONFIG_FILE = "/data/integrations-config.json";

const INTEGRATION_KEYS = [
  "whatsapp",
  "gmail",
  "ssh",
  "scheduled",
  "calendar",
  "homeassistant",
  "rss",
  "owntracks",
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export type IntegrationsConfig = Record<IntegrationKey, boolean>;

const DEFAULTS: IntegrationsConfig = {
  whatsapp: true,
  gmail: true,
  ssh: true,
  scheduled: true,
  calendar: true,
  homeassistant: true,
  rss: true,
  owntracks: true,
};

function ensureDir(): void {
  const dir = "/data";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getIntegrationsConfig(): IntegrationsConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      return { ...DEFAULTS, ...raw };
    }
  } catch {}
  return { ...DEFAULTS };
}

export function isIntegrationEnabled(key: IntegrationKey): boolean {
  return getIntegrationsConfig()[key] !== false;
}

export function saveIntegrationsConfig(partial: Partial<IntegrationsConfig>): IntegrationsConfig {
  ensureDir();
  const current = getIntegrationsConfig();
  for (const [k, v] of Object.entries(partial)) {
    if (INTEGRATION_KEYS.includes(k as IntegrationKey) && typeof v === "boolean") {
      current[k as IntegrationKey] = v;
    }
  }
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(current, null, 2));
  renameSync(tmp, CONFIG_FILE);
  return current;
}

export function isValidIntegrationKey(key: string): key is IntegrationKey {
  return INTEGRATION_KEYS.includes(key as IntegrationKey);
}
