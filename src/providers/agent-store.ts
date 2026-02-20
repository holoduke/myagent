import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { appendFileSync } from "fs";
import type { AgentProfile } from "./types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [agent-store] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const AGENTS_DIR = process.env.AGENTS_DIR || "/data/agents";

function ensureDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
    log(`Created agents directory: ${AGENTS_DIR}`);
  }
}

function profilePath(id: string): string {
  return join(AGENTS_DIR, `${id}.json`);
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

export function setDefault(id: string): void {
  const agents = listAgents();
  for (const agent of agents) {
    const wasDefault = agent.isDefault;
    agent.isDefault = agent.id === id;
    if (agent.isDefault !== wasDefault) {
      saveAgent(agent);
    }
  }
  log(`Set default agent: ${id}`);
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
