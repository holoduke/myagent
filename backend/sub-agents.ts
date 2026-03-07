import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from "fs";
import { createLogger } from "./logger.js";

import { getBrainConfig, getOwnerLocalTime } from "./brain-config.js";

const log = createLogger("sub-agents");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";
const REGISTRY_FILE = `${BRAIN_DIR}/sub-agents.json`;
const STATE_FILE = `${BRAIN_DIR}/sub-agents-state.json`;
const HISTORY_FILE = `${BRAIN_DIR}/sub-agents-history.json`;

// ── Types ──

export interface SubAgentSchedule {
  hours: number[];
  daysOfWeek?: number[];
}

export interface SubAgentConfig {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string;
  schedule: SubAgentSchedule;
  enabled: boolean;
  timeout: number;
  maxHistoryRuns: number;
  createdAt: number;
  lastRunAt: number;
  source: "brain" | "owner";
}

export interface SubAgentRun {
  id: string;
  agentId: string;
  startedAt: number;
  completedAt: number;
  success: boolean;
  summary: string;
  details: string;
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface SubAgentState {
  runningAgents: Record<string, { pid?: number; startedAt: number }>;
}

export interface SubAgentTask {
  agentId: string;
  name: string;
  prompt: string;
  tools: string;
  timeout: number;
}

export interface SubAgentResult {
  agentId: string;
  success: boolean;
  summary: string;
  details: string;
  metrics?: Record<string, unknown>;
  error?: string;
  completedAt: number;
}

// ── Persistence helpers ──

function ensureDir(): void {
  if (!existsSync(BRAIN_DIR)) {
    mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

function atomicWrite(filepath: string, data: string): void {
  ensureDir();
  const tmp = filepath + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, filepath);
}

// ── Registry (CRUD) ──

export function loadSubAgents(): SubAgentConfig[] {
  try {
    if (existsSync(REGISTRY_FILE)) {
      return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load sub-agents: ${err}`);
  }
  return [];
}

export function saveSubAgents(agents: SubAgentConfig[]): void {
  atomicWrite(REGISTRY_FILE, JSON.stringify(agents, null, 2));
}

export function getSubAgent(id: string): SubAgentConfig | undefined {
  return loadSubAgents().find(a => a.id === id);
}

export function addSubAgent(
  agent: Omit<SubAgentConfig, "id" | "createdAt" | "lastRunAt">,
): SubAgentConfig {
  const agents = loadSubAgents();
  const newAgent: SubAgentConfig = {
    ...agent,
    id: `sa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    lastRunAt: 0,
  };
  agents.push(newAgent);
  saveSubAgents(agents);
  log(`Added sub-agent: ${newAgent.name} (${newAgent.id})`);
  return newAgent;
}

export function updateSubAgent(
  id: string,
  updates: Partial<Pick<SubAgentConfig, "name" | "description" | "prompt" | "tools" | "schedule" | "enabled" | "timeout" | "maxHistoryRuns">>,
): SubAgentConfig | null {
  const agents = loadSubAgents();
  const agent = agents.find(a => a.id === id);
  if (!agent) return null;

  if (updates.name !== undefined) agent.name = updates.name;
  if (updates.description !== undefined) agent.description = updates.description;
  if (updates.prompt !== undefined) agent.prompt = updates.prompt;
  if (updates.tools !== undefined) agent.tools = updates.tools;
  if (updates.schedule !== undefined) agent.schedule = updates.schedule;
  if (updates.enabled !== undefined) agent.enabled = updates.enabled;
  if (updates.timeout !== undefined) agent.timeout = updates.timeout;
  if (updates.maxHistoryRuns !== undefined) agent.maxHistoryRuns = updates.maxHistoryRuns;

  saveSubAgents(agents);
  log(`Updated sub-agent: ${agent.name} (${id})`);
  return agent;
}

export function deleteSubAgent(id: string): boolean {
  const agents = loadSubAgents();
  const idx = agents.findIndex(a => a.id === id);
  if (idx === -1) return false;

  const [removed] = agents.splice(idx, 1);
  saveSubAgents(agents);

  // Clean up history for this agent
  const history = loadAllHistory();
  delete history[id];
  saveAllHistory(history);

  // Clean up any task/result files
  const taskFile = taskFilePath(id);
  const resultFile = resultFilePath(id);
  try { if (existsSync(taskFile)) unlinkSync(taskFile); } catch {}
  try { if (existsSync(resultFile)) unlinkSync(resultFile); } catch {}

  // Clear running state
  clearRunning(id);

  log(`Deleted sub-agent: ${removed.name} (${id})`);
  return true;
}

// ── Scheduling ──

const MIN_RUN_INTERVAL = 50 * 60 * 1000; // 50 minutes

export function isDue(agent: SubAgentConfig, now: Date): boolean {
  if (!agent.enabled) return false;
  if (isRunning(agent.id)) return false;
  if (agent.lastRunAt > 0 && (now.getTime() - agent.lastRunAt) < MIN_RUN_INTERVAL) return false;

  const { hour: currentHour, dayOfWeek: currentDay } = getOwnerLocalTime(getBrainConfig().ownerTimezone, now);
  if (!agent.schedule.hours.includes(currentHour)) return false;
  if (agent.schedule.daysOfWeek && !agent.schedule.daysOfWeek.includes(currentDay)) return false;

  return true;
}

export function getDueSubAgents(): SubAgentConfig[] {
  const agents = loadSubAgents();
  if (agents.length === 0) {
    const defaults = seedDefaults();
    return defaults.filter(a => isDue(a, new Date()));
  }
  return agents.filter(a => isDue(a, new Date()));
}

// ── Runtime State ──

export function loadSubAgentState(): SubAgentState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return { runningAgents: {} };
}

function saveSubAgentState(state: SubAgentState): void {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

export function markRunning(agentId: string, pid?: number): void {
  const state = loadSubAgentState();
  state.runningAgents[agentId] = { pid, startedAt: Date.now() };
  saveSubAgentState(state);
}

export function clearRunning(agentId: string): void {
  const state = loadSubAgentState();
  delete state.runningAgents[agentId];
  saveSubAgentState(state);
}

export function isRunning(agentId: string): boolean {
  const state = loadSubAgentState();
  return !!state.runningAgents[agentId];
}

// ── Task / Result File Paths ──

export function taskFilePath(agentId: string): string {
  return `${BRAIN_DIR}/sub-agent-task-${agentId}.json`;
}

export function resultFilePath(agentId: string): string {
  return `${BRAIN_DIR}/sub-agent-result-${agentId}.json`;
}

// ── History ──

export function loadAllHistory(): Record<string, SubAgentRun[]> {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load sub-agent history: ${err}`);
  }
  return {};
}

function saveAllHistory(history: Record<string, SubAgentRun[]>): void {
  atomicWrite(HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function loadSubAgentHistory(agentId: string): SubAgentRun[] {
  const history = loadAllHistory();
  return history[agentId] || [];
}

export function addRunToHistory(run: SubAgentRun): void {
  const history = loadAllHistory();
  if (!history[run.agentId]) history[run.agentId] = [];
  history[run.agentId].unshift(run);

  // Trim to max history per agent
  const agent = getSubAgent(run.agentId);
  const maxRuns = agent?.maxHistoryRuns || 20;
  if (history[run.agentId].length > maxRuns) {
    history[run.agentId] = history[run.agentId].slice(0, maxRuns);
  }

  saveAllHistory(history);
}

// ── Seed Defaults ──

function seedDefaults(): SubAgentConfig[] {
  const now = Date.now();
  const defaults: SubAgentConfig[] = [
    {
      id: "sa_website_tester",
      name: "Website Tester",
      description: "Tests football-mania.com availability, response times, and key pages twice daily.",
      prompt: `You are a website testing agent. Test football-mania.com comprehensively.

Perform these checks using curl via the Bash tool:
1. **Homepage**: curl -sL -o /dev/null -w "%{http_code} %{time_total}" https://football-mania.com/
2. **SSL Check**: curl -sI https://football-mania.com/ — verify HTTPS works
3. **Key Pages**: Check these return HTTP 200:
   - https://football-mania.com/
   - https://football-mania.com/live
4. **Response Time**: Record total_time for the homepage
5. **Content Check**: curl -s https://football-mania.com/ | head -50 — verify it contains HTML content

For each check record: URL, HTTP status, response time in ms, pass/fail.

Output ONLY a JSON object (no markdown, no backticks):
{
  "success": true/false,
  "summary": "X of Y checks passed",
  "details": "Full report with each check result",
  "metrics": { "homepage_ms": number, "pages_checked": number, "pages_ok": number, "ssl_valid": boolean }
}`,
      tools: "Bash,WebFetch",
      schedule: { hours: [9, 21] },
      enabled: true,
      timeout: 120000,
      maxHistoryRuns: 30,
      createdAt: now,
      lastRunAt: 0,
      source: "owner",
    },
  ];

  saveSubAgents(defaults);
  log(`Seeded ${defaults.length} default sub-agent(s)`);
  return defaults;
}
