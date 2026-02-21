import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { appendFileSync } from "fs";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [tools] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

const JOBS_DIR = process.env.JOBS_DIR || "/data/jobs";
const REGISTRY_FILE = `${JOBS_DIR}/tools.json`;

// ── Types ──

export interface Tool {
  id: string;                    // "tool_" + timestamp
  name: string;                  // e.g. "yt-dlp", "aria2", "ffmpeg"
  description: string;           // What this tool does
  imageName: string;             // Docker image name e.g. "aria-tool-ytdlp"
  dockerfile: string;            // The Dockerfile content used to build it
  capabilities: string[];        // Tags: ["video download", "audio extract"]
  builtAt: number;
  lastUsedAt: number;
  timesUsed: number;
  imageSize?: string;            // e.g. "145MB"
  defaultCommand?: string;        // Default command to run in this tool
  buildFiles?: Record<string, string>;  // Extra files needed for build
  status: "building" | "ready" | "failed" | "removed";
  buildLog?: string;             // Build output for debugging
}

export interface ToolRegistry {
  tools: Tool[];
}

// ── Persistence ──

function ensureDir(): void {
  if (!existsSync(JOBS_DIR)) {
    mkdirSync(JOBS_DIR, { recursive: true });
  }
}

export function loadRegistry(): ToolRegistry {
  try {
    if (existsSync(REGISTRY_FILE)) {
      return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load registry: ${err}`);
  }
  return { tools: [] };
}

export function saveRegistry(registry: ToolRegistry): void {
  ensureDir();
  const tmp = REGISTRY_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(registry, null, 2));
  renameSync(tmp, REGISTRY_FILE);
}

// ── Registry Operations ──

export function registerTool(params: {
  name: string;
  description: string;
  imageName: string;
  dockerfile: string;
  capabilities: string[];
  imageSize?: string;
  status?: Tool["status"];
  buildLog?: string;
}): Tool {
  const registry = loadRegistry();
  const now = Date.now();
  const tool: Tool = {
    id: `tool_${now}`,
    name: params.name,
    description: params.description,
    imageName: params.imageName,
    dockerfile: params.dockerfile,
    capabilities: params.capabilities,
    builtAt: now,
    lastUsedAt: now,
    timesUsed: 0,
    imageSize: params.imageSize,
    status: params.status || "building",
    buildLog: params.buildLog,
  };
  registry.tools.push(tool);
  saveRegistry(registry);
  log(`Registered tool: ${tool.id} — ${tool.name}`);
  return tool;
}

export function getTool(id: string): Tool | undefined {
  const registry = loadRegistry();
  return registry.tools.find(t => t.id === id);
}

export function getToolByName(name: string): Tool | undefined {
  const registry = loadRegistry();
  return registry.tools.find(t => t.name === name);
}

export function findToolByCapability(capability: string): Tool[] {
  const registry = loadRegistry();
  const lower = capability.toLowerCase();
  return registry.tools.filter(t =>
    t.capabilities.some(c => c.toLowerCase().includes(lower)),
  );
}

export function updateTool(id: string, updates: Partial<Tool>): Tool {
  const registry = loadRegistry();
  const tool = registry.tools.find(t => t.id === id);
  if (!tool) throw new Error(`Tool not found: ${id}`);
  Object.assign(tool, updates);
  saveRegistry(registry);
  log(`Updated tool: ${id} — ${JSON.stringify(updates).slice(0, 120)}`);
  return tool;
}

export function getAllTools(): Tool[] {
  const registry = loadRegistry();
  return registry.tools;
}

export function markUsed(id: string): Tool {
  const registry = loadRegistry();
  const tool = registry.tools.find(t => t.id === id);
  if (!tool) throw new Error(`Tool not found: ${id}`);
  tool.lastUsedAt = Date.now();
  tool.timesUsed += 1;
  saveRegistry(registry);
  log(`Marked tool used: ${id} — ${tool.name} (${tool.timesUsed} uses)`);
  return tool;
}
