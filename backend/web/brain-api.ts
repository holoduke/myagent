import { IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { spawn } from "child_process";
import { listWorkerLogs, openWorkerLog, WORKER_LOGS_DIR } from "../worker-logs.js";
import { getBrainConfig, saveBrainConfig, getActivePreset, BRAIN_PRESETS, CHARACTER_PRESETS } from "../brain-config.js";
import { resetConsecutiveFailures } from "../brain.js";
import { getDefaultDetectionPrompt } from "../prompt-detector.js";
import type { BrainConfig } from "../brain-config.js";
import {
  loadQueue,
  loadHistory,
  approveItem,
  rejectItem,
  deleteItem,
  getWeeklyCompletedCount,
} from "../self-improve-queue.js";
import { getAllRecurringTasks, addRecurringTask, updateRecurringTask, deleteRecurringTask } from "../recurring.js";
import {
  loadSubAgents,
  addSubAgent,
  updateSubAgent,
  deleteSubAgent,
  getSubAgent,
  loadSubAgentHistory,
  loadAllHistory as loadAllSubAgentHistory,
  loadSubAgentState,
  markRunning,
  taskFilePath,
} from "../sub-agents.js";
import { detectInitiativeSignals } from "../initiative.js";
import { GoalTracker } from "../goals.js";
import { MemoryGraph } from "../memory/graph.js";
import { loadWorkingMemory } from "../memory/working-memory.js";
import type { MemoryNode, MemoryEdge } from "../memory/types.js";
import type { GoalData, RetentionTier } from "../memory/types.js";
import { classifyRetentionTier } from "../memory/decay.js";
import { loadSnapshot, detectDrift } from "../memory/drift-detection.js";
import { getEmbeddingCount } from "../memory/embeddings.js";
import { getChannelHealth } from "../integrations/channel-adapter.js";
import type { ChannelStatus } from "../integrations/channel-adapter.js";
import { isAuthenticated } from "./auth.js";
import { respondJson, apiHandler, apiGetHandler, ApiError } from "../utils/api-helpers.js";
import { createLogger } from "../logger.js";
import { BRAIN_DIR } from "../config.js";
import {
  createBackup,
  listBackups,
  getBackup,
  restoreBackup,
  deleteBackup,
} from "../memory/backup.js";

const log = createLogger("web");


/** Sanitize IDs from URL params to prevent path traversal (e.g. "../../etc/passwd"). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-]/g, "");
}

export const BRAIN_CONFIG_ALLOWED_KEYS: (keyof BrainConfig)[] = [
  "enabled", "maxMessagesPerDay", "minMessageInterval", "quietStart", "quietEnd",
  "ownerTimezone",
  "thinkCooldown", "consolidateInterval", "reflectInterval", "tickInterval", "preset",
  "selfImproveEnabled", "selfImproveAutoApprove", "selfImproveMaxPerWeek",
  "selfImproveMinPerDay", "selfImproveDailyHour", "selfImproveAutoMerge",
  "characterType", "characterCustomPrompt",
  "detectionMode", "detectionPrompt",
  "selfCritiqueEnabled", "selfCritiqueThreshold",
  "urgencyInterruptThreshold",
  "activationSpreadFactor", "archiveRecallMin", "archiveRecallMax", "archiveRecallDivisor",
  "maxThinkContextNodes",
  "models",
];

export function parseGoalData(content: string): GoalData | null {
  try {
    const match = content.match(/\[GOAL_DATA\]([\s\S]*)\[\/GOAL_DATA\]/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function loadBrainGraph(): MemoryGraph {
  const graph = new MemoryGraph();
  graph.load();
  return graph;
}

export function getBrainGoals(filter?: string): { nodeId: string; data: GoalData }[] {
  const graph = loadBrainGraph();
  const goalNodes = graph.findByType("goal");
  const goals: { nodeId: string; data: GoalData }[] = [];

  for (const node of goalNodes) {
    const data = parseGoalData(node.content);
    if (data) {
      if (!filter || data.status === filter) {
        goals.push({ nodeId: node.id, data });
      }
    }
  }

  return goals.sort((a, b) => a.data.priority - b.data.priority);
}

export function getBrainDashboard() {
  const graph = loadBrainGraph();
  const wm = loadWorkingMemory();

  const goalNodes = graph.findByType("goal");
  const goals: { nodeId: string; data: GoalData }[] = [];
  for (const node of goalNodes) {
    const data = parseGoalData(node.content);
    if (data) goals.push({ nodeId: node.id, data });
  }
  goals.sort((a, b) => a.data.priority - b.data.priority);

  return {
    goals,
    recurringTasks: getAllRecurringTasks(),
    signals: detectInitiativeSignals(graph, wm),
    followUps: wm.pendingFollowUps,
  };
}

export function getAriaStatus(): Record<string, unknown> {
  const status: Record<string, unknown> = {};

  try {
    const f = `${BRAIN_DIR}/state.json`;
    if (existsSync(f)) status.brainState = JSON.parse(readFileSync(f, "utf-8"));
  } catch { /* expected: state file may not exist yet */ }

  try {
    const f = `${BRAIN_DIR}/working-memory.json`;
    if (existsSync(f)) status.workingMemory = JSON.parse(readFileSync(f, "utf-8"));
  } catch { /* expected: working memory file may not exist yet */ }

  try {
    const graph = new MemoryGraph();
    graph.load();
    const nodeList = graph.allNodes();
    const edges = graph.allEdges();

    if (nodeList.length > 0 || edges.length > 0) {
      const byType: Record<string, number> = {};
      let totalStrength = 0;
      for (const n of nodeList) {
        byType[n.type] = (byType[n.type] || 0) + 1;
        totalStrength += n.strength;
      }

      const pinned = nodeList.filter(n => n.pinned).sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
      const strongest = nodeList
        .filter(n => !n.pinned)
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0))
        .slice(0, 20);
      const weakest = nodeList
        .filter(n => !n.pinned && (n.strength ?? 0) < 0.2)
        .sort((a, b) => (a.strength ?? 0) - (b.strength ?? 0))
        .slice(0, 10);
      const recent = [...nodeList]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, 10);

      const conceptTree = nodeList
        .filter(n => n.type === "concept")
        .map(concept => {
          const children = edges
            .filter(e => e.from === concept.id && e.type === "hierarchical")
            .map(e => nodeList.find(n => n.id === e.to))
            .filter((n): n is MemoryNode => n !== null && n !== undefined)
            .map(n => ({ id: n.id, type: n.type, content: n.content || "", tags: n.tags || [], strength: n.strength ?? 0 }));
          return {
            id: concept.id,
            content: concept.content || "",
            strength: concept.strength ?? 0,
            childCount: children.length,
            children,
          };
        })
        .sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));

      const tierDistribution: Record<RetentionTier, number> = { core: 0, important: 0, work: 0, standard: 0, ephemeral: 0 };
      for (const node of nodeList) {
        const tier = classifyRetentionTier(node, graph);
        tierDistribution[tier]++;
      }

      const graphStats = graph.getStats();

      status.graph = {
        nodeCount: nodeList.length,
        edgeCount: edges.length,
        byType,
        avgStrength: nodeList.length > 0 ? totalStrength / nodeList.length : 0,
        retentionTiers: tierDistribution,
        archivedCount: graphStats.archivedCount,
        ghostCount: graphStats.ghostCount,
        embeddingCount: getEmbeddingCount(),
        pinnedNodes: pinned.map(n => ({ id: n.id, type: n.type, content: n.content || "", tags: n.tags || [], strength: n.strength ?? 0 })),
        strongestNodes: strongest.map(n => ({ id: n.id, type: n.type, content: n.content || "", tags: n.tags || [], strength: n.strength ?? 0, accessCount: n.accessCount ?? 0 })),
        weakestNodes: weakest.map(n => ({ id: n.id, type: n.type, content: n.content || "", strength: n.strength ?? 0 })),
        recentNodes: recent.map(n => ({ id: n.id, type: n.type, content: n.content || "", tags: n.tags || [], strength: n.strength ?? 0, createdAt: n.createdAt ?? 0 })),
        edges: edges.slice(0, 200).map(e => ({ from: e.from, to: e.to, type: e.type, weight: e.weight })),
        conceptTree,
      };
    }
  } catch (err) {
    log(`Failed to load graph for status: ${err}`);
  }

  try {
    const taskFile = `${BRAIN_DIR}/improve-task.json`;
    const resultFile = `${BRAIN_DIR}/improve-result.json`;
    const bootCounterFile = `${BRAIN_DIR}/boot-counter`;
    const lastGoodCommitFile = `${BRAIN_DIR}/last-good-commit`;

    status.selfImprove = {
      pendingTask: existsSync(taskFile) ? JSON.parse(readFileSync(taskFile, "utf-8")) : null,
      lastResult: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf-8")) : null,
      bootCounter: existsSync(bootCounterFile) ? parseInt(readFileSync(bootCounterFile, "utf-8").trim(), 10) : 0,
      lastGoodCommit: existsSync(lastGoodCommitFile) ? readFileSync(lastGoodCommitFile, "utf-8").trim() : null,
    };
  } catch { /* expected: self-improve files may not exist */ }

  try {
    status.channelHealth = getChannelHealth();
  } catch { /* channels may not be initialized */ }

  status.timestamp = Date.now();
  return status;
}

export function getMoltbookStatus() {
  if (!existsSync(MOLTBOOK_CREDS)) return { ...moltbookCache, enabled: false };

  if (Date.now() - moltbookLastFetch < MOLTBOOK_CACHE_MS && moltbookCache.enabled) return moltbookCache;

  try {
    const creds = JSON.parse(readFileSync(MOLTBOOK_CREDS, "utf-8"));
    const apiKey = creds.api_key;
    if (!apiKey) return { ...moltbookCache, enabled: false };

    moltbookCache = {
      enabled: true,
      name: creds.name || "aria-agent",
      profileUrl: creds.profile_url || `https://www.moltbook.com/u/${creds.name}`,
      karma: moltbookCache.karma,
      followers: moltbookCache.followers,
      postCount: moltbookCache.postCount,
      lastActive: moltbookCache.lastActive,
    };

    fetch("https://www.moltbook.com/api/v1/agents/status", {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
      .then(r => r.json())
      .then((data: Record<string, unknown>) => {
        const agent = (data.agent || {}) as Record<string, unknown>;
        moltbookCache = {
          enabled: true,
          name: (agent.name as string) || creds.name || "aria-agent",
          profileUrl: creds.profile_url || `https://www.moltbook.com/u/${agent.name || creds.name}`,
          karma: (agent.karma as number) || 0,
          followers: (agent.followerCount as number) || 0,
          postCount: (agent.postCount as number) || 0,
          lastActive: (agent.lastActive as string) || null,
        };
        moltbookLastFetch = Date.now();
      })
      .catch(() => { /* silent */ });
  } catch { /* silent */ }

  return moltbookCache;
}

// -- Moltbook status (cached, refreshed in background) --
const MOLTBOOK_CREDS = "/data/moltbook/credentials.json";
const MOLTBOOK_CACHE_MS = 5 * 60 * 1000; // 5 min
let moltbookCache: {
  enabled: boolean; name: string; profileUrl: string;
  karma: number; followers: number; postCount: number; lastActive: string | null;
} = { enabled: false, name: "", profileUrl: "", karma: 0, followers: 0, postCount: 0, lastActive: null };
let moltbookLastFetch = 0;

export function handleBrainRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // -- Improve queue --
  if (pathname === "/api/improve-queue" && req.method === "GET" && isAuthenticated(req)) {
    handleImproveQueueGet(req, res);
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+\/approve$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[3]);
    handleImproveQueueAction(req, res, () => approveItem(id));
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+\/reject$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[3]);
    handleImproveQueueAction(req, res, () => { rejectItem(id); return { ok: true }; });
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+$/) && req.method === "DELETE" && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[3]);
    handleImproveQueueAction(req, res, () => { deleteItem(id); return { ok: true }; });
    return true;
  }

  // -- Reset consecutive failures --
  if (pathname === "/api/brain/reset-failures" && req.method === "POST" && isAuthenticated(req)) {
    resetConsecutiveFailures();
    respondJson(res, 200, { ok: true, message: "Consecutive failures reset" });
    return true;
  }

  // -- Brain dashboard (composite) --
  if (pathname === "/api/brain/dashboard" && req.method === "GET" && isAuthenticated(req)) {
    handleBrainDashboardGet(req, res);
    return true;
  }

  // -- Brain recurring tasks CRUD --
  if (pathname === "/api/brain/recurring" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getAllRecurringTasks());
      return true;
    }
    if (req.method === "POST") {
      handleBrainRecurringAdd(req, res);
      return true;
    }
  }

  if (pathname.match(/^\/api\/brain\/recurring\/[^/]+$/) && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[4]);
    if (req.method === "PUT") {
      handleBrainRecurringUpdate(req, res, id);
      return true;
    }
    if (req.method === "DELETE") {
      const deleted = deleteRecurringTask(id);
      respondJson(res, 200, { ok: deleted });
      return true;
    }
  }

  // -- Brain goals CRUD --
  if (pathname === "/api/brain/goals" && isAuthenticated(req)) {
    if (req.method === "GET") {
      handleBrainGoalsGet(req, res);
      return true;
    }
    if (req.method === "POST") {
      handleBrainGoalCreate(req, res);
      return true;
    }
  }

  if (pathname.match(/^\/api\/brain\/goals\/[^/]+$/) && req.method === "PUT" && isAuthenticated(req)) {
    const nodeId = sanitizeId(pathname.split("/")[4]);
    handleBrainGoalUpdate(req, res, nodeId);
    return true;
  }

  if (pathname.match(/^\/api\/brain\/goals\/[^/]+\/complete$/) && req.method === "POST" && isAuthenticated(req)) {
    const nodeId = sanitizeId(pathname.split("/")[4]);
    handleBrainGoalAction(res, nodeId, "complete");
    return true;
  }

  if (pathname.match(/^\/api\/brain\/goals\/[^/]+\/abandon$/) && req.method === "POST" && isAuthenticated(req)) {
    const nodeId = sanitizeId(pathname.split("/")[4]);
    handleBrainGoalAction(res, nodeId, "abandon");
    return true;
  }

  // -- Memory backups CRUD --
  if (pathname === "/api/brain/backups" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, listBackups());
      return true;
    }
    if (req.method === "POST") {
      handleBackupCreate(req, res);
      return true;
    }
  }

  if (pathname.match(/^\/api\/brain\/backups\/[^/]+\/restore$/) && req.method === "POST" && isAuthenticated(req)) {
    const ts = sanitizeId(pathname.split("/")[4]);
    handleBackupRestore(req, res, ts);
    return true;
  }

  if (pathname.match(/^\/api\/brain\/backups\/[^/]+$/) && isAuthenticated(req)) {
    const ts = sanitizeId(pathname.split("/")[4]);
    if (req.method === "GET") {
      const detail = getBackup(ts);
      if (!detail) {
        respondJson(res, 404, { error: "Backup not found" });
      } else {
        respondJson(res, 200, detail);
      }
      return true;
    }
    if (req.method === "DELETE") {
      try {
        deleteBackup(ts);
        respondJson(res, 200, { ok: true });
      } catch (err) {
        respondJson(res, 400, { error: err instanceof Error ? err.message : "Delete failed" });
      }
      return true;
    }
  }

  // -- Brain signals (read-only) --
  if (pathname === "/api/brain/signals" && req.method === "GET" && isAuthenticated(req)) {
    handleBrainSignalsGet(req, res);
    return true;
  }

  // -- Drift detection (read-only) --
  if (pathname === "/api/brain/drift" && req.method === "GET" && isAuthenticated(req)) {
    handleBrainDriftGet(req, res);
    return true;
  }

  // -- Brain follow-ups (read-only) --
  if (pathname === "/api/brain/follow-ups" && req.method === "GET" && isAuthenticated(req)) {
    handleBrainFollowUpsGet(req, res);
    return true;
  }

  // -- Memory node relationships --
  if (pathname.match(/^\/api\/memory\/node\/[^/]+\/relationships$/) && req.method === "GET" && isAuthenticated(req)) {
    const nodeId = pathname.split("/")[4];
    handleMemoryNodeRelationships(req, res, nodeId);
    return true;
  }

  // -- Brain config --
  if (pathname === "/api/brain-config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      const config = getBrainConfig();
      respondJson(res, 200, {
        config,
        activePreset: getActivePreset(config),
        presets: BRAIN_PRESETS,
        characterPresets: CHARACTER_PRESETS,
      });
      return true;
    }
    if (req.method === "PUT") {
      handleBrainConfigUpdate(req, res);
      return true;
    }
  }

  // -- Detection prompt default --
  if (pathname === "/api/detection-prompt/default" && isAuthenticated(req)) {
    respondJson(res, 200, { prompt: getDefaultDetectionPrompt() });
    return true;
  }

  // -- Sub-Agents CRUD --
  if (pathname === "/api/sub-agents" && isAuthenticated(req)) {
    if (req.method === "GET") {
      const agents = loadSubAgents();
      const state = loadSubAgentState();
      const allHistory = loadAllSubAgentHistory();
      const recentRuns: Record<string, unknown[]> = {};
      for (const [agentId, runs] of Object.entries(allHistory)) {
        recentRuns[agentId] = runs.slice(0, 5);
      }
      respondJson(res, 200, { agents, state, recentRuns });
      return true;
    }
    if (req.method === "POST") {
      handleSubAgentCreate(req, res);
      return true;
    }
  }

  const subAgentMatch = pathname.match(/^\/api\/sub-agents\/([^/]+)$/);
  if (subAgentMatch && isAuthenticated(req)) {
    const id = sanitizeId(decodeURIComponent(subAgentMatch[1]));
    if (req.method === "GET") {
      const agent = getSubAgent(id);
      if (!agent) {
        respondJson(res, 404, { error: "Not found" });
      } else {
        respondJson(res, 200, agent);
      }
      return true;
    }
    if (req.method === "PUT") {
      handleSubAgentUpdate(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      const deleted = deleteSubAgent(id);
      respondJson(res, 200, { ok: deleted });
      return true;
    }
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/toggle$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[3]);
    const agent = getSubAgent(id);
    if (!agent) {
      respondJson(res, 404, { error: "Not found" });
    } else {
      const updated = updateSubAgent(id, { enabled: !agent.enabled });
      respondJson(res, 200, updated);
    }
    return true;
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/history$/) && req.method === "GET" && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[3]);
    respondJson(res, 200, loadSubAgentHistory(id));
    return true;
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/run$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = sanitizeId(pathname.split("/")[3]);
    const agent = getSubAgent(id);
    if (!agent) {
      respondJson(res, 404, { error: "Not found" });
    } else {
      const state = loadSubAgentState();
      if (state.runningAgents[id]) {
        respondJson(res, 409, { error: "Agent is already running" });
      } else {
        const tFile = taskFilePath(id);
        writeFileSync(tFile, JSON.stringify({
          agentId: id,
          name: agent.name,
          prompt: agent.prompt,
          tools: agent.tools,
          timeout: agent.timeout,
        }, null, 2));
        const logFd = openWorkerLog(`sub-agent-${id}-${Date.now()}`);
        const child = spawn("npx", ["tsx", "backend/sub-agent-worker.ts", id], {
          detached: true, stdio: ["ignore", logFd, logFd], cwd: "/app", env: { ...process.env },
        });
        markRunning(id, child.pid);
        child.unref();
        respondJson(res, 200, { ok: true, message: "Run triggered" });
      }
    }
    return true;
  }

  // -- Worker Logs --
  if (pathname === "/api/worker-logs" && req.method === "GET" && isAuthenticated(req)) {
    const logs = listWorkerLogs();
    respondJson(res, 200, logs);
    return true;
  }

  const workerLogStreamMatch = pathname.match(/^\/api\/worker-logs\/([^/]+)\/stream$/);
  if (workerLogStreamMatch && req.method === "GET" && isAuthenticated(req)) {
    const id = workerLogStreamMatch[1].replace(/[^a-zA-Z0-9_-]/g, "_");
    handleWorkerLogStream(req, res, id);
    return true;
  }

  const workerLogRawMatch = pathname.match(/^\/api\/worker-logs\/([^/]+)$/);
  if (workerLogRawMatch && req.method === "GET" && isAuthenticated(req)) {
    const id = workerLogRawMatch[1].replace(/[^a-zA-Z0-9_-]/g, "_");
    const logPath = `${WORKER_LOGS_DIR}/${id}.log`;
    if (!existsSync(logPath)) {
      respondJson(res, 404, { error: "Log not found" });
    } else {
      const content = readFileSync(logPath, "utf-8");
      respondJson(res, 200, { id, content, size: content.length });
    }
    return true;
  }

  return false;
}

// -- Worker Log SSE streaming handler --

function handleWorkerLogStream(req: IncomingMessage, res: ServerResponse, logId: string): void {
  const logPath = `${WORKER_LOGS_DIR}/${logId}.log`;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send existing content first
  let offset = 0;
  if (existsSync(logPath)) {
    const existing = readFileSync(logPath, "utf-8");
    if (existing.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "content", text: existing })}\n\n`);
      offset = Buffer.byteLength(existing, "utf-8");
    }
  }

  // Poll for new content every 500ms
  const interval = setInterval(() => {
    try {
      if (!existsSync(logPath)) return;
      const stats = statSync(logPath);
      if (stats.size > offset) {
        const fd = openSync(logPath, "r");
        const buf = Buffer.alloc(stats.size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = stats.size;
        const text = buf.toString("utf-8");
        if (text) {
          res.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
        }
      }
    } catch { /* file might not exist yet */ }
  }, 500);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`:heartbeat\n\n`);
  }, 15000);

  req.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });

  res.on("close", () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
}

// -- Sub-Agent handlers --

const handleSubAgentCreate = apiHandler(async (_req, res, data: Record<string, unknown>) => {
  const agent = addSubAgent({
    name: (data.name as string) || "Untitled Agent",
    description: (data.description as string) || "",
    prompt: (data.prompt as string) || "",
    tools: (data.tools as string) || "Bash,WebFetch",
    schedule: (data.schedule as { hours: number[] }) || { hours: [9, 21] },
    enabled: data.enabled !== false,
    timeout: (data.timeout as number) || 300000,
    maxHistoryRuns: (data.maxHistoryRuns as number) || 20,
    source: "owner",
  });
  respondJson(res, 201, agent);
});

const handleSubAgentUpdate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  const url = new URL(_req.url || "/", "http://localhost");
  const id = decodeURIComponent(url.pathname.split("/")[3]);
  const updated = updateSubAgent(id, data);
  if (!updated) {
    throw new ApiError(404, "Not found");
  }
  return updated;
});

// -- Improve queue handlers --

const handleImproveQueueGet = apiGetHandler(() => {
  const q = loadQueue();
  const h = loadHistory();
  return { queue: q.items, history: h.entries, weeklyCount: getWeeklyCompletedCount() };
});

function handleImproveQueueAction(_req: IncomingMessage, res: ServerResponse, action: () => unknown) {
  try {
    const result = action();
    respondJson(res, 200, result);
  } catch (err) {
    respondJson(res, 400, { error: String(err) });
  }
}

// -- Brain dashboard handler --

const handleBrainDashboardGet = apiGetHandler(() => getBrainDashboard());

// -- Brain signals handler --

const handleBrainSignalsGet = apiGetHandler(() => {
  const graph = new MemoryGraph();
  graph.load();
  const wm = loadWorkingMemory();
  return detectInitiativeSignals(graph, wm);
});

// -- Drift detection handler --

const handleBrainDriftGet = apiGetHandler(() => {
  const graph = new MemoryGraph();
  graph.load();
  const report = detectDrift(graph);
  const latestSnapshot = loadSnapshot(0);
  return {
    report,
    snapshotTimestamp: latestSnapshot?.timestamp ?? null,
    pinnedCount: latestSnapshot?.pinnedNodes.length ?? 0,
  };
});

// -- Brain follow-ups handler --

const handleBrainFollowUpsGet = apiGetHandler(() => {
  const wm = loadWorkingMemory();
  return wm.pendingFollowUps;
});

// -- Brain goals GET handler --

const handleBrainGoalsGet = apiGetHandler(() => getBrainGoals());

// -- Memory node relationships handler --

function handleMemoryNodeRelationships(_req: IncomingMessage, res: ServerResponse, nodeId: string) {
  try {
    const graph = new MemoryGraph();
    graph.load();
    const node = graph.getNode(nodeId);
    if (!node) {
      respondJson(res, 404, { error: "Node not found" });
      return;
    }
    const parents = graph.getParents(nodeId).map(n => ({ id: n.id, type: n.type, content: n.content, strength: n.strength }));
    const children = graph.getChildren(nodeId).map(n => ({ id: n.id, type: n.type, content: n.content, strength: n.strength }));
    const siblingIds = new Set<string>();
    const siblings: { id: string; type: string; content: string; strength: number }[] = [];
    for (const parent of graph.getParents(nodeId)) {
      for (const child of graph.getChildren(parent.id)) {
        if (child.id !== nodeId && !siblingIds.has(child.id)) {
          siblingIds.add(child.id);
          siblings.push({ id: child.id, type: child.type, content: child.content, strength: child.strength });
        }
      }
    }
    const edges = graph.edgesFor(nodeId).map(e => ({ from: e.from, to: e.to, type: e.type, weight: e.weight }));
    respondJson(res, 200, {
      node: { id: node.id, type: node.type, content: node.content, tags: node.tags, strength: node.strength },
      parents, children, siblings, edges,
    });
  } catch (err) {
    respondJson(res, 500, { error: String(err) });
  }
}

// -- Brain recurring task handlers --

const handleBrainRecurringAdd = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  if (!data.label || !data.type || !data.pattern || !data.action) {
    throw new ApiError(400, "label, type, pattern, and action are required");
  }
  return addRecurringTask(data as unknown as Parameters<typeof addRecurringTask>[0]);
});

async function handleBrainRecurringUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
    const task = updateRecurringTask(id, data);
    if (!task) throw new ApiError(404, "Task not found");
    return task;
  });
  await handler(req, res);
}

// -- Brain goal handlers --

const handleBrainGoalCreate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  if (!data.title || !data.description) throw new ApiError(400, "title and description are required");
  const graph = loadBrainGraph();
  const tracker = new GoalTracker(graph);
  tracker.applyGoalOps([{
    op: "create_goal" as const,
    title: data.title as string,
    description: data.description as string,
    priority: (data.priority || 2) as 1 | 2 | 3,
    deadline: data.deadline as number | undefined,
    checkpoints: data.checkpoints as string[] | undefined,
    createdBy: "owner" as const,
  }]);
  graph.save();
  return { ok: true };
});

async function handleBrainGoalUpdate(req: IncomingMessage, res: ServerResponse, nodeId: string) {
  const handler = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
    const graph = loadBrainGraph();
    const tracker = new GoalTracker(graph);
    tracker.applyGoalOps([{
      op: "update_goal" as const,
      nodeId,
      progress: data.progress as number | undefined,
      status: data.status as "active" | "completed" | "abandoned" | "paused" | undefined,
      checkpoints: data.checkpoints as { label: string; done: boolean }[] | undefined,
    }]);
    graph.save();
    return { ok: true };
  });
  await handler(req, res);
}

function handleBrainGoalAction(res: ServerResponse, nodeId: string, action: "complete" | "abandon") {
  try {
    const graph = loadBrainGraph();
    const tracker = new GoalTracker(graph);
    if (action === "complete") {
      tracker.applyGoalOps([{ op: "complete_goal", nodeId }]);
    } else {
      tracker.applyGoalOps([{ op: "abandon_goal", nodeId }]);
    }
    graph.save();
    respondJson(res, 200, { ok: true });
  } catch (err) {
    log(`Goal ${action} error: ${err}`);
    respondJson(res, 400, { error: "Invalid request" });
  }
}

// -- Backup handlers --

const handleBackupCreate = apiGetHandler(() => {
  return createBackup("manual");
});

function handleBackupRestore(_req: IncomingMessage, res: ServerResponse, ts: string) {
  try {
    restoreBackup(ts);
    respondJson(res, 200, { ok: true });
  } catch (err) {
    respondJson(res, 400, { error: err instanceof Error ? err.message : "Restore failed" });
  }
}

// -- Brain config handler --

const handleBrainConfigUpdate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  let update: Partial<BrainConfig>;

  if (data.preset && typeof data.preset === "string") {
    const preset = BRAIN_PRESETS.find(p => p.name === data.preset);
    if (!preset) throw new ApiError(400, `Unknown preset: ${data.preset}`);
    update = { ...preset.values, preset: data.preset };
    if ("enabled" in data && typeof data.enabled === "boolean") update.enabled = data.enabled;
    if ("selfImproveEnabled" in data && typeof data.selfImproveEnabled === "boolean") update.selfImproveEnabled = data.selfImproveEnabled;
    if ("selfImproveAutoApprove" in data && typeof data.selfImproveAutoApprove === "boolean") update.selfImproveAutoApprove = data.selfImproveAutoApprove;
    if ("selfImproveMaxPerWeek" in data && typeof data.selfImproveMaxPerWeek === "number") update.selfImproveMaxPerWeek = data.selfImproveMaxPerWeek;
  } else {
    update = {};
    for (const key of BRAIN_CONFIG_ALLOWED_KEYS) {
      if (key in data && key !== "preset" && key !== "models") {
        (update as Record<string, unknown>)[key] = data[key];
      }
    }

    // Validate models sub-object: only known keys with known values
    if ("models" in data && data.models !== null && typeof data.models === "object" && !Array.isArray(data.models)) {
      const VALID_MODELS = new Set(["haiku", "sonnet", "opus", "opus-4-7", "fable", "fable-5", "grok", "grok-mini"]);
      const VALID_MODEL_KEYS = new Set(["think", "consolidate", "reflect", "selfCritique", "messageEval", "driftAudit", "selfImprove", "vision", "newsDigest"]);
      const incoming = data.models as Record<string, unknown>;
      const validated: Record<string, string> = {};
      for (const k of VALID_MODEL_KEYS) {
        if (k in incoming) {
          const v = incoming[k];
          if (typeof v !== "string" || !VALID_MODELS.has(v)) {
            throw new ApiError(400, `Invalid model value for "${k}": ${v}`);
          }
          validated[k] = v;
        }
      }
      update.models = validated as unknown as BrainConfig["models"];
    }

    update.preset = null;
  }

  const config = saveBrainConfig(update);
  return {
    config,
    activePreset: getActivePreset(config),
    presets: BRAIN_PRESETS,
    characterPresets: CHARACTER_PRESETS,
  };
});
