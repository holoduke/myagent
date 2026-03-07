import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import type { AgentProfile } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("agent-store");

const AGENTS_DIR = process.env.AGENTS_DIR || "/data/agents";

function ensureDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
    log(`Created agents directory: ${AGENTS_DIR}`);
  }
}

/** Sanitize agent ID to prevent path traversal */
function sanitizeId(id: string): string {
  // Strip anything that isn't alphanumeric, dash, or underscore
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function profilePath(id: string): string {
  const safe = sanitizeId(id);
  if (!safe) throw new Error("Invalid agent ID");
  const full = join(AGENTS_DIR, `${safe}.json`);
  // Double-check the resolved path stays inside AGENTS_DIR
  if (!full.startsWith(AGENTS_DIR)) throw new Error("Invalid agent ID");
  return full;
}

/** Mask sensitive fields before returning to API callers */
export function maskSecrets(profile: AgentProfile): AgentProfile {
  const masked = { ...profile, config: { ...profile.config } };
  const cfg = masked.config as Record<string, unknown>;
  if (cfg.apiKey && typeof cfg.apiKey === "string") {
    cfg.apiKey = cfg.apiKey.slice(0, 4) + "****";
  }
  return masked;
}

export function listAgents(): AgentProfile[] {
  ensureDir();
  const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith(".json"));
  const agents: AgentProfile[] = [];
  for (const file of files) {
    try {
      const data = readFileSync(join(AGENTS_DIR, file), "utf-8");
      agents.push(JSON.parse(data) as AgentProfile);
    } catch (err) {
      log(`Failed to read agent file ${file}: ${err}`);
    }
  }
  return agents.sort((a, b) => a.createdAt - b.createdAt);
}

export function getAgent(id: string): AgentProfile | null {
  ensureDir();
  const path = profilePath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AgentProfile;
  } catch {
    return null;
  }
}

export function saveAgent(profile: AgentProfile): AgentProfile {
  ensureDir();
  profile.updatedAt = Date.now();
  writeFileSync(profilePath(profile.id), JSON.stringify(profile, null, 2));
  log(`Saved agent: ${profile.id} (${profile.name})`);
  return profile;
}

export function deleteAgent(id: string): boolean {
  const path = profilePath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  log(`Deleted agent: ${id}`);
  return true;
}

export function getDefaultAgent(): AgentProfile | null {
  const agents = listAgents();
  return agents.find(a => a.isDefault) || agents[0] || null;
}

export function setDefault(id: string): boolean {
  const agents = listAgents();
  const target = agents.find(a => a.id === id);
  if (!target) return false;

  for (const agent of agents) {
    const wasDefault = agent.isDefault;
    agent.isDefault = agent.id === id;
    if (agent.isDefault !== wasDefault) {
      saveAgent(agent);
    }
  }
  log(`Set default agent: ${id}`);
  return true;
}

export function bootstrapDefaultAgent(): void {
  ensureDir();
  const agents = listAgents();
  if (agents.length > 0) return;

  const defaultAgent: AgentProfile = {
    id: "claude-default",
    name: "Claude",
    provider: "claude",
    isDefault: true,
    config: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveAgent(defaultAgent);
  log("Bootstrapped default Claude agent");
}
