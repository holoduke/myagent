import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { ensureDir } from "../utils/file-store.js";
import { join, basename } from "path";
import type { ProviderProfile } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("provider-store");

const PROVIDERS_DIR = process.env.AGENTS_DIR || "/data/agents";

function ensureProviderDir(): void {
  if (!existsSync(PROVIDERS_DIR)) {
    ensureDir(PROVIDERS_DIR);
    log(`Created providers directory: ${PROVIDERS_DIR}`);
  }
}

/** Sanitize provider ID to prevent path traversal */
function sanitizeId(id: string): string {
  // Strip anything that isn't alphanumeric, dash, or underscore
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function profilePath(id: string): string {
  const safe = sanitizeId(id);
  if (!safe) throw new Error("Invalid provider ID");
  const full = join(PROVIDERS_DIR, `${safe}.json`);
  // Double-check the resolved path stays inside PROVIDERS_DIR
  if (!full.startsWith(PROVIDERS_DIR)) throw new Error("Invalid provider ID");
  return full;
}

/** Mask sensitive fields before returning to API callers */
export function maskSecrets(profile: ProviderProfile): ProviderProfile {
  const masked = { ...profile, config: { ...profile.config } };
  const cfg = masked.config as Record<string, unknown>;
  if (cfg.apiKey && typeof cfg.apiKey === "string") {
    cfg.apiKey = cfg.apiKey.slice(0, 4) + "****";
  }
  return masked;
}

export function listProviders(): ProviderProfile[] {
  ensureProviderDir();
  const files = readdirSync(PROVIDERS_DIR).filter(f => f.endsWith(".json"));
  const providers: ProviderProfile[] = [];
  for (const file of files) {
    try {
      const data = readFileSync(join(PROVIDERS_DIR, file), "utf-8");
      providers.push(JSON.parse(data) as ProviderProfile);
    } catch (err) {
      log(`Failed to read provider file ${file}: ${err}`);
    }
  }
  return providers.sort((a, b) => a.createdAt - b.createdAt);
}

export function getProvider(id: string): ProviderProfile | null {
  ensureProviderDir();
  const path = profilePath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProviderProfile;
  } catch {
    return null;
  }
}

export function saveProvider(profile: ProviderProfile): ProviderProfile {
  ensureProviderDir();
  profile.updatedAt = Date.now();
  writeFileSync(profilePath(profile.id), JSON.stringify(profile, null, 2));
  log(`Saved provider: ${profile.id} (${profile.name})`);
  return profile;
}

export function deleteProvider(id: string): boolean {
  const path = profilePath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  log(`Deleted provider: ${id}`);
  return true;
}

export function getDefaultProvider(): ProviderProfile | null {
  const providers = listProviders();
  return providers.find(a => a.isDefault) || providers[0] || null;
}

export function setDefault(id: string): boolean {
  const providers = listProviders();
  const target = providers.find(a => a.id === id);
  if (!target) return false;

  for (const provider of providers) {
    const wasDefault = provider.isDefault;
    provider.isDefault = provider.id === id;
    if (provider.isDefault !== wasDefault) {
      saveProvider(provider);
    }
  }
  log(`Set default provider: ${id}`);
  return true;
}

export function bootstrapDefaultProvider(): void {
  ensureProviderDir();
  const providers = listProviders();
  if (providers.length > 0) return;

  const defaultProvider: ProviderProfile = {
    id: "claude-default",
    name: "Claude",
    provider: "claude",
    isDefault: true,
    config: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveProvider(defaultProvider);
  log("Bootstrapped default Claude provider");
}
