import { safeReadJSON, atomicWriteJSON, ensureDir } from "../utils/file-store.js";
import { createLogger } from "../logger.js";

const log = createLogger("integration-config");
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
  "twilio",
  "browser",
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
  twilio: true,
  browser: true,
};

export function getIntegrationsConfig(): IntegrationsConfig {
  const saved = safeReadJSON<Partial<IntegrationsConfig>>(CONFIG_FILE, {});
  return { ...DEFAULTS, ...saved };
}

export function isIntegrationEnabled(key: IntegrationKey): boolean {
  return getIntegrationsConfig()[key] !== false;
}

export function saveIntegrationsConfig(partial: Partial<IntegrationsConfig>): IntegrationsConfig {
  ensureDir("/data");
  const current = getIntegrationsConfig();
  for (const [k, v] of Object.entries(partial)) {
    if (INTEGRATION_KEYS.includes(k as IntegrationKey) && typeof v === "boolean") {
      current[k as IntegrationKey] = v;
    }
  }
  atomicWriteJSON(CONFIG_FILE, current);
  return current;
}

export function isValidIntegrationKey(key: string): key is IntegrationKey {
  return INTEGRATION_KEYS.includes(key as IntegrationKey);
}
