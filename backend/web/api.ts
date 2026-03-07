import { IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { resetSession } from "../claude.js";
import { getDefaultProvider } from "../providers/index.js";
import { MessageQueue } from "../queue.js";
import { getHistory, addMessage, clearHistory, getUsageStats, getUsageData } from "../history.js";
import { syncContacts, findContacts, getAllContacts, getWhatsAppStatus } from "../integrations/whatsapp.js";
import { getScheduledMessages } from "../scheduler.js";
import { getWhitelist, addToWhitelist, removeFromWhitelist } from "../contact-whitelist.js";
import { getAccountStatus, addAccount, removeAccount } from "../integrations/gmail.js";
import { getLatestQr } from "../integrations/whatsapp.js";
import { getSSHStatus, getPublicKey, addTarget, removeTarget, testConnection } from "../integrations/ssh.js";
import { getCalendarStatus, createEvent } from "../integrations/calendar.js";
import { getHAStatus, saveConfig, restartHAPolling, testHAConnection } from "../integrations/homeassistant.js";
import type { HAConfig, HAConnectionMode } from "../integrations/homeassistant.js";
import { getRSSStatus, addFeed, removeFeed } from "../integrations/rss.js";
import { getOwnTracksStatus } from "../integrations/owntracks.js";
import { getTwilioStatus, makeSimpleCall, makeAgentCall, saveConfig as saveTwilioConfig, loadCallHistory } from "../integrations/twilio.js";
import { getIntegrationsConfig, saveIntegrationsConfig, isValidIntegrationKey } from "../integrations/integration-config.js";
import { isAuthenticated, readBody } from "./auth.js";
import type { MemoryNode, MemoryEdge } from "../memory/types.js";
import { getBrainConfig, saveBrainConfig, getActivePreset, BRAIN_PRESETS, CHARACTER_PRESETS } from "../brain-config.js";
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
import type { GoalData, RetentionTier } from "../memory/types.js";
import { classifyRetentionTier } from "../memory/decay.js";
import { createLogger } from "../logger.js";

const log = createLogger("web");

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";

export function handleApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  queue: MessageQueue,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // ── Auth check (no auth needed) ──
  if (pathname === "/api/auth-check") {
    const ok = isAuthenticated(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: ok }));
    return true;
  }

  // ── Chat SSE ──
  if (pathname === "/api/chat" && req.method === "POST") {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }
    handleChat(req, res, queue);
    return true;
  }

  // ── History ──
  if (pathname === "/api/history" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getHistory()));
    return true;
  }

  // ── ARIA status (full brain/graph data) ──
  if (pathname === "/api/aria/status" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getAriaStatus()));
    return true;
  }

  // ── Dashboard composite endpoint ──
  if (pathname === "/api/dashboard" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getDashboardData(queue)));
    return true;
  }

  // ── Scheduled messages ──
  if (pathname === "/api/scheduled" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getScheduledMessages()));
    return true;
  }

  // ── Whitelist CRUD ──
  if (pathname === "/api/whitelist" && isAuthenticated(req)) {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getWhitelist()));
      return true;
    }
    if (req.method === "POST") {
      handleWhitelistAdd(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleWhitelistRemove(req, res);
      return true;
    }
  }

  // ── Contact sync ──
  if (pathname === "/api/sync-contacts" && req.method === "POST" && isAuthenticated(req)) {
    syncContacts()
      .then(() => {
        setTimeout(() => {
          const contacts = getAllContacts();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, contactCount: contacts.length }));
        }, 3000);
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
    return true;
  }

  // ── Contacts search ──
  if (pathname === "/api/contacts" && isAuthenticated(req)) {
    const query = url.searchParams.get("q");
    const contacts = query ? findContacts(query) : getAllContacts();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(contacts));
    return true;
  }

  // ── SSH public key ──
  if (pathname === "/api/ssh/public-key" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ publicKey: getPublicKey() }));
    return true;
  }

  // ── SSH targets CRUD ──
  if (pathname === "/api/ssh/targets" && isAuthenticated(req)) {
    if (req.method === "POST") {
      handleSSHAddTarget(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleSSHRemoveTarget(req, res);
      return true;
    }
  }

  // ── SSH test connection ──
  if (pathname === "/api/ssh/test" && req.method === "POST" && isAuthenticated(req)) {
    handleSSHTest(req, res);
    return true;
  }

  // ── Gmail account CRUD ──
  if (pathname === "/api/gmail/accounts" && isAuthenticated(req)) {
    if (req.method === "POST") {
      handleGmailAddAccount(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleGmailRemoveAccount(req, res);
      return true;
    }
  }

  // ── WhatsApp QR ──
  if (pathname === "/api/whatsapp/qr" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ qr: getLatestQr() }));
    return true;
  }

  // ── Calendar status ──
  if (pathname === "/api/calendar/status" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getCalendarStatus()));
    return true;
  }

  // ── Calendar event creation ──
  if (pathname === "/api/calendar/events" && req.method === "POST" && isAuthenticated(req)) {
    readBody(req).then(async (raw) => {
      try {
        const body = JSON.parse(raw);
        const { accountId, summary, startDateTime, endDateTime, location } = body;
        if (!accountId || !summary || !startDateTime || !endDateTime) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required fields: accountId, summary, startDateTime, endDateTime" }));
          return;
        }
        const result = await createEvent(accountId, summary, startDateTime, endDateTime, location);
        res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "Invalid request" }));
      }
    });
    return true;
  }

  // ── Home Assistant config CRUD ──
  if (pathname === "/api/homeassistant/status" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getHAStatus()));
    return true;
  }

  if (pathname === "/api/homeassistant/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getHAStatus()));
      return true;
    }
    if (req.method === "PUT") {
      handleHASaveConfig(req, res);
      return true;
    }
  }

  if (pathname === "/api/homeassistant/test" && req.method === "POST" && isAuthenticated(req)) {
    handleHATestConnection(req, res);
    return true;
  }

  // ── RSS feeds CRUD ──
  if (pathname === "/api/rss/feeds" && isAuthenticated(req)) {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getRSSStatus()));
      return true;
    }
    if (req.method === "POST") {
      handleRSSAddFeed(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleRSSRemoveFeed(req, res);
      return true;
    }
  }

  // ── OwnTracks status ──
  if (pathname === "/api/owntracks/status" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getOwnTracksStatus()));
    return true;
  }

  // ── Twilio voice calling ──
  if (pathname === "/api/twilio/status" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getTwilioStatus()));
    return true;
  }

  if (pathname === "/api/twilio/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getTwilioStatus()));
      return true;
    }
    if (req.method === "PUT") {
      handleTwilioSaveConfig(req, res);
      return true;
    }
  }

  if (pathname === "/api/twilio/call" && req.method === "POST" && isAuthenticated(req)) {
    handleTwilioCall(req, res);
    return true;
  }

  if (pathname === "/api/twilio/history" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadCallHistory()));
    return true;
  }

  // ── Integrations config ──
  if (pathname === "/api/integrations/config" && req.method === "PUT" && isAuthenticated(req)) {
    handleIntegrationsConfigUpdate(req, res);
    return true;
  }

  // ── Improve queue ──
  if (pathname === "/api/improve-queue" && req.method === "GET" && isAuthenticated(req)) {
    try {
      const queue = loadQueue();
      const history = loadHistory();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        queue: queue.items,
        history: history.entries,
        weeklyCount: getWeeklyCompletedCount(),
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+\/approve$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    try {
      const item = approveItem(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(item));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+\/reject$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    try {
      rejectItem(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+$/) && req.method === "DELETE" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    try {
      deleteItem(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  // ── Brain dashboard (composite) ──
  if (pathname === "/api/brain/dashboard" && req.method === "GET" && isAuthenticated(req)) {
    try {
      const data = getBrainDashboard();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      log(`Brain dashboard error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  // ── Brain recurring tasks CRUD ──
  if (pathname === "/api/brain/recurring" && isAuthenticated(req)) {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getAllRecurringTasks()));
      return true;
    }
    if (req.method === "POST") {
      handleBrainRecurringAdd(req, res);
      return true;
    }
  }

  if (pathname.match(/^\/api\/brain\/recurring\/[^/]+$/) && isAuthenticated(req)) {
    const id = pathname.split("/")[4];
    if (req.method === "PUT") {
      handleBrainRecurringUpdate(req, res, id);
      return true;
    }
    if (req.method === "DELETE") {
      const deleted = deleteRecurringTask(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: deleted }));
      return true;
    }
  }

  // ── Brain goals CRUD ──
  if (pathname === "/api/brain/goals" && isAuthenticated(req)) {
    if (req.method === "GET") {
      try {
        const goals = getBrainGoals();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(goals));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return true;
    }
    if (req.method === "POST") {
      handleBrainGoalCreate(req, res);
      return true;
    }
  }

  if (pathname.match(/^\/api\/brain\/goals\/[^/]+$/) && req.method === "PUT" && isAuthenticated(req)) {
    const nodeId = pathname.split("/")[4];
    handleBrainGoalUpdate(req, res, nodeId);
    return true;
  }

  if (pathname.match(/^\/api\/brain\/goals\/[^/]+\/complete$/) && req.method === "POST" && isAuthenticated(req)) {
    const nodeId = pathname.split("/")[4];
    handleBrainGoalAction(res, nodeId, "complete");
    return true;
  }

  if (pathname.match(/^\/api\/brain\/goals\/[^/]+\/abandon$/) && req.method === "POST" && isAuthenticated(req)) {
    const nodeId = pathname.split("/")[4];
    handleBrainGoalAction(res, nodeId, "abandon");
    return true;
  }

  // ── Brain signals (read-only) ──
  if (pathname === "/api/brain/signals" && req.method === "GET" && isAuthenticated(req)) {
    try {
      const graph = new MemoryGraph();
      graph.load();
      const wm = loadWorkingMemory();
      const signals = detectInitiativeSignals(graph, wm);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(signals));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  // ── Brain follow-ups (read-only) ──
  if (pathname === "/api/brain/follow-ups" && req.method === "GET" && isAuthenticated(req)) {
    try {
      const wm = loadWorkingMemory();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(wm.pendingFollowUps));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  // ── Memory node relationships ──
  if (pathname.match(/^\/api\/memory\/node\/[^/]+\/relationships$/) && req.method === "GET" && isAuthenticated(req)) {
    const nodeId = pathname.split("/")[4];
    try {
      const graph = new MemoryGraph();
      graph.load();
      const node = graph.getNode(nodeId);
      if (!node) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node not found" }));
        return true;
      }
      const parents = graph.getParents(nodeId).map(n => ({ id: n.id, type: n.type, content: n.content, strength: n.strength }));
      const children = graph.getChildren(nodeId).map(n => ({ id: n.id, type: n.type, content: n.content, strength: n.strength }));
      // Siblings: other children of this node's parents
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        node: { id: node.id, type: node.type, content: node.content, tags: node.tags, strength: node.strength },
        parents,
        children,
        siblings,
        edges,
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return true;
  }

  // ── Brain config ──
  if (pathname === "/api/brain-config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      const config = getBrainConfig();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        config,
        activePreset: getActivePreset(config),
        presets: BRAIN_PRESETS,
        characterPresets: CHARACTER_PRESETS,
      }));
      return true;
    }
    if (req.method === "PUT") {
      handleBrainConfigUpdate(req, res);
      return true;
    }
  }

  // ── Sub-Agents CRUD ──
  if (pathname === "/api/sub-agents" && isAuthenticated(req)) {
    if (req.method === "GET") {
      const agents = loadSubAgents();
      const state = loadSubAgentState();
      const allHistory = loadAllSubAgentHistory();
      // Trim history to last 5 per agent for the list view
      const recentRuns: Record<string, unknown[]> = {};
      for (const [agentId, runs] of Object.entries(allHistory)) {
        recentRuns[agentId] = runs.slice(0, 5);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agents, state, recentRuns }));
      return true;
    }
    if (req.method === "POST") {
      handleSubAgentCreate(req, res);
      return true;
    }
  }

  const subAgentMatch = pathname.match(/^\/api\/sub-agents\/([^/]+)$/);
  if (subAgentMatch && isAuthenticated(req)) {
    const id = decodeURIComponent(subAgentMatch[1]);
    if (req.method === "GET") {
      const agent = getSubAgent(id);
      if (!agent) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(agent));
      }
      return true;
    }
    if (req.method === "PUT") {
      handleSubAgentUpdate(req, res, id);
      return true;
    }
    if (req.method === "DELETE") {
      const deleted = deleteSubAgent(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: deleted }));
      return true;
    }
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/toggle$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    const agent = getSubAgent(id);
    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } else {
      const updated = updateSubAgent(id, { enabled: !agent.enabled });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
    }
    return true;
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/history$/) && req.method === "GET" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    const history = loadSubAgentHistory(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(history));
    return true;
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/run$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    const agent = getSubAgent(id);
    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } else {
      const state = loadSubAgentState();
      if (state.runningAgents[id]) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Agent is already running" }));
      } else {
        // Write task file and spawn worker directly
        const tFile = taskFilePath(id);
        writeFileSync(tFile, JSON.stringify({
          agentId: id,
          name: agent.name,
          prompt: agent.prompt,
          tools: agent.tools,
          timeout: agent.timeout,
        }, null, 2));
        markRunning(id, undefined);
        const child = spawn("npx", ["tsx", "backend/sub-agent-worker.ts", id], {
          detached: true, stdio: "ignore", cwd: "/app", env: { ...process.env },
        });
        child.unref();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Run triggered" }));
      }
    }
    return true;
  }

  return false;
}

// ── Sub-Agent handlers ──

async function handleSubAgentCreate(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const agent = addSubAgent({
      name: data.name || "Untitled Agent",
      description: data.description || "",
      prompt: data.prompt || "",
      tools: data.tools || "Bash,WebFetch",
      schedule: data.schedule || { hours: [9, 21] },
      enabled: data.enabled !== false,
      timeout: data.timeout || 300000,
      maxHistoryRuns: data.maxHistoryRuns || 20,
      source: "owner",
    });
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agent));
  } catch (err) {
    log(`Sub-agent create error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleSubAgentUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const updated = updateSubAgent(id, data);
    if (!updated) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
    }
  } catch (err) {
    log(`Sub-agent update error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── Dashboard composite data ──
function getDashboardData(queue: MessageQueue) {
  const status = getAriaStatus();
  const waStatus = getWhatsAppStatus();
  const gmailAccounts = getAccountStatus();
  const whitelist = getWhitelist();
  const scheduled = getScheduledMessages();
  const ssh = getSSHStatus();

  return {
    brainState: status.brainState,
    workingMemory: status.workingMemory,
    graph: status.graph ? {
      nodeCount: (status.graph as Record<string, unknown>).nodeCount,
      edgeCount: (status.graph as Record<string, unknown>).edgeCount,
    } : { nodeCount: 0, edgeCount: 0 },
    selfImprove: status.selfImprove,
    whatsapp: waStatus,
    gmail: {
      total: gmailAccounts.length,
      authenticated: gmailAccounts.filter(a => a.authenticated).length,
    },
    gmailAccounts,
    ssh,
    calendar: getCalendarStatus(),
    homeassistant: getHAStatus(),
    rss: getRSSStatus(),
    owntracks: getOwnTracksStatus(),
    twilio: getTwilioStatus(),
    whitelistCount: whitelist.length,
    scheduledCount: scheduled.length,
    queueDepth: queue.size,
    claudeUsage: getUsageData(),
    integrationsEnabled: getIntegrationsConfig(),
    timestamp: Date.now(),
  };
}

// ── ARIA Status (brain/graph full data) ──
function getAriaStatus(): Record<string, unknown> {
  const status: Record<string, unknown> = {};

  try {
    const f = `${BRAIN_DIR}/state.json`;
    if (existsSync(f)) status.brainState = JSON.parse(readFileSync(f, "utf-8"));
  } catch {}

  try {
    const f = `${BRAIN_DIR}/working-memory.json`;
    if (existsSync(f)) status.workingMemory = JSON.parse(readFileSync(f, "utf-8"));
  } catch {}

  try {
    const nf = `${BRAIN_DIR}/graph/nodes.json`;
    const ef = `${BRAIN_DIR}/graph/edges.json`;
    if (existsSync(nf)) {
      const nodesRaw = JSON.parse(readFileSync(nf, "utf-8")) as Record<string, MemoryNode>;
      const nodeList = Object.values(nodesRaw).filter((n): n is MemoryNode => n != null && typeof n === "object" && typeof n.id === "string");
      const edges: MemoryEdge[] = existsSync(ef) ? JSON.parse(readFileSync(ef, "utf-8")) : [];

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

      // Build concept tree: find concept nodes and their hierarchical children
      const conceptTree = nodeList
        .filter(n => n.type === "concept")
        .map(concept => {
          const children = edges
            .filter(e => e.from === concept.id && e.type === "hierarchical")
            .map(e => nodeList.find(n => n.id === e.to))
            .filter((n): n is MemoryNode => n != null)
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

      // Compute retention tier distribution (load full graph for connection-based classification)
      const tierGraph = new MemoryGraph();
      tierGraph.load();
      const tierDistribution: Record<RetentionTier, number> = { core: 0, important: 0, work: 0, standard: 0, ephemeral: 0 };
      for (const node of nodeList) {
        const tier = classifyRetentionTier(node, tierGraph);
        tierDistribution[tier]++;
      }

      status.graph = {
        nodeCount: nodeList.length,
        edgeCount: edges.length,
        byType,
        avgStrength: nodeList.length > 0 ? totalStrength / nodeList.length : 0,
        retentionTiers: tierDistribution,
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
  } catch {}

  status.timestamp = Date.now();
  return status;
}

// ── Chat SSE handler ──
async function handleChat(req: IncomingMessage, res: ServerResponse, queue: MessageQueue) {
  try {
    const body = await readBody(req);
    const { message } = JSON.parse(body);

    if (!message?.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Message is required" }));
      return;
    }

    log(`Chat: "${message.slice(0, 80)}"`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`data: ${JSON.stringify({ type: "queued" })}\n\n`);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`:heartbeat\n\n`);
    }, 15000);

    try {
      await queue.add(async () => {
        if (res.writableEnded) return;

        if (message.trim().toLowerCase() === "/reset") {
          resetSession();
          clearHistory();
          res.write(`data: ${JSON.stringify({ type: "delta", text: "Session reset. Starting fresh conversation." })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          return;
        }

        if (message.trim().toLowerCase() === "/usage") {
          const stats = getUsageStats();
          res.write(`data: ${JSON.stringify({ type: "delta", text: stats })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          return;
        }

        addMessage({ role: "user", content: message, timestamp: Date.now(), source: "web" });

        res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);

        const provider = getDefaultProvider();
        let fullResponse = "";
        let result;

        if (provider.supportsStreaming) {
          result = await provider.askStreaming(message, (delta) => {
            fullResponse += delta;
            if (!res.writableEnded) {
              res.write(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`);
            }
          }, {});
        } else {
          // Non-streaming provider: run blocking then emit full response
          result = await provider.ask(message, {});
          fullResponse = result.messages.join("\n");
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "delta", text: fullResponse })}\n\n`);
          }
        }

        addMessage({
          role: "assistant",
          content: fullResponse || result.messages.join("\n"),
          timestamp: Date.now(),
          source: "web",
          stats: result.stats ? {
            durationMs: result.stats.durationMs,
            totalCostUsd: result.stats.totalCostUsd,
            inputTokens: result.stats.inputTokens,
            outputTokens: result.stats.outputTokens,
            numTurns: result.stats.numTurns,
          } : undefined,
        });

        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: "done", sessionId: result.sessionId, stats: result.stats })}\n\n`);
        }
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      log(`Chat error: ${errorMsg}`);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", error: errorMsg })}\n\n`);
      }
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
  }
}

// ── Whitelist handlers ──
async function handleWhitelistAdd(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { jid, name } = JSON.parse(body);
    if (!jid || !name) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "jid and name are required" }));
      return;
    }
    addToWhitelist(jid, name);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleWhitelistRemove(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { jid } = JSON.parse(body);
    if (!jid) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "jid is required" }));
      return;
    }
    const removed = removeFromWhitelist(jid);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: removed }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── SSH handlers ──
async function handleSSHAddTarget(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { label, host, user, port } = JSON.parse(body);
    if (!label || !host || !user) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "label, host, and user are required" }));
      return;
    }
    const target = addTarget(label, host, user, port || 22);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, target }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleSSHRemoveTarget(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { id } = JSON.parse(body);
    if (!id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "id is required" }));
      return;
    }
    const removed = removeTarget(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: removed }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleSSHTest(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { id } = JSON.parse(body);
    if (!id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "id is required" }));
      return;
    }
    const result = await testConnection(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── Gmail handlers ──
async function handleGmailAddAccount(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { id, email, clientId, clientSecret, redirectUri } = JSON.parse(body);
    if (!id || !email || !clientId || !clientSecret) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "id, email, clientId, and clientSecret are required" }));
      return;
    }
    const uri = redirectUri || `${req.headers.origin || "http://localhost:3000"}/gmail/callback`;
    const account = addAccount(id, email, clientId, clientSecret, uri);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, account: { id: account.id, email: account.email } }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleGmailRemoveAccount(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { id } = JSON.parse(body);
    if (!id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "id is required" }));
      return;
    }
    const removed = removeAccount(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: removed }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── RSS handlers ──
async function handleRSSAddFeed(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { name, url } = JSON.parse(body);
    if (!name || !url) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "name and url are required" }));
      return;
    }
    const feed = addFeed(name.trim(), url.trim());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, feed }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleRSSRemoveFeed(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { id } = JSON.parse(body);
    if (!id) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "id is required" }));
      return;
    }
    const removed = removeFeed(id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: removed }));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── Integrations config handler ──

async function handleIntegrationsConfigUpdate(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);

    // Validate: all keys must be valid integration keys with boolean values
    for (const [key, val] of Object.entries(data)) {
      if (!isValidIntegrationKey(key)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown integration key: ${key}` }));
        return;
      }
      if (typeof val !== "boolean") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Value for "${key}" must be a boolean` }));
        return;
      }
    }

    const config = saveIntegrationsConfig(data);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── Home Assistant handlers ──

async function handleHASaveConfig(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);

    const mode = data.mode as HAConnectionMode;
    if (!mode || !["direct_api", "cloud"].includes(mode)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mode must be 'direct_api' or 'cloud'" }));
      return;
    }

    const config: HAConfig = {
      mode,
      entities: Array.isArray(data.entities) ? data.entities : ["light", "switch", "lock", "climate", "binary_sensor", "sensor"],
      pollInterval: typeof data.pollInterval === "number" ? data.pollInterval : 60000,
    };

    if (data.direct_api && typeof data.direct_api === "object") {
      config.direct_api = {
        url: String(data.direct_api.url || ""),
        token: String(data.direct_api.token || ""),
      };
    }

    if (data.cloud && typeof data.cloud === "object") {
      config.cloud = {
        url: String(data.cloud.url || ""),
        token: String(data.cloud.token || ""),
      };
    }

    saveConfig(config);
    restartHAPolling();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, status: getHAStatus() }));
  } catch (err) {
    log(`HA config save error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleHATestConnection(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { mode, url, token } = JSON.parse(body);

    if (!mode || !url || !token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mode, url, and token are required" }));
      return;
    }

    const result = await testHAConnection(mode as HAConnectionMode, url, token);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    log(`HA test connection error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── Brain config handler ──

const BRAIN_CONFIG_ALLOWED_KEYS: (keyof BrainConfig)[] = [
  "enabled", "maxMessagesPerDay", "minMessageInterval", "quietStart", "quietEnd",
  "ownerTimezone",
  "thinkCooldown", "consolidateInterval", "reflectInterval", "tickInterval", "preset",
  "selfImproveEnabled", "selfImproveAutoApprove", "selfImproveMaxPerWeek",
  "characterType", "characterCustomPrompt",
];

// ── Brain dashboard helpers ──

function parseGoalData(content: string): GoalData | null {
  try {
    const match = content.match(/\[GOAL_DATA\]([\s\S]*)\[\/GOAL_DATA\]/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function serializeGoalData(data: GoalData): string {
  return `${data.title}\n[GOAL_DATA]${JSON.stringify(data)}[/GOAL_DATA]`;
}

function loadBrainGraph(): MemoryGraph {
  const graph = new MemoryGraph();
  graph.load();
  return graph;
}

function getBrainGoals(filter?: string): { nodeId: string; data: GoalData }[] {
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

function getBrainDashboard() {
  const graph = loadBrainGraph();
  const wm = loadWorkingMemory();
  const tracker = new GoalTracker(graph);

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

async function handleBrainRecurringAdd(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    if (!data.label || !data.type || !data.pattern || !data.action) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "label, type, pattern, and action are required" }));
      return;
    }
    const task = addRecurringTask({
      type: data.type,
      label: data.label,
      pattern: data.pattern,
      action: data.action,
      enabled: data.enabled !== false,
      source: data.source || "owner",
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleBrainRecurringUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const task = updateRecurringTask(id, data);
    if (!task) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(task));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleBrainGoalCreate(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    if (!data.title || !data.description) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "title and description are required" }));
      return;
    }
    const graph = loadBrainGraph();
    const tracker = new GoalTracker(graph);
    tracker.applyGoalOps([{
      op: "create_goal",
      title: data.title,
      description: data.description,
      priority: data.priority || 2,
      deadline: data.deadline,
      checkpoints: data.checkpoints,
      createdBy: "owner",
    }]);
    graph.save();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log(`Goal create error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleBrainGoalUpdate(req: IncomingMessage, res: ServerResponse, nodeId: string) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const graph = loadBrainGraph();
    const tracker = new GoalTracker(graph);
    tracker.applyGoalOps([{
      op: "update_goal",
      nodeId,
      progress: data.progress,
      status: data.status,
      checkpoints: data.checkpoints,
    }]);
    graph.save();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log(`Goal update error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    log(`Goal ${action} error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleBrainConfigUpdate(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);

    let update: Partial<BrainConfig>;

    if (data.preset && typeof data.preset === "string") {
      // Apply preset values
      const preset = BRAIN_PRESETS.find(p => p.name === data.preset);
      if (!preset) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown preset: ${data.preset}` }));
        return;
      }
      update = { ...preset.values, preset: data.preset };
      // Respect explicit enabled override alongside preset
      if ("enabled" in data && typeof data.enabled === "boolean") {
        update.enabled = data.enabled;
      }
      // Forward self-improve fields alongside preset
      if ("selfImproveEnabled" in data && typeof data.selfImproveEnabled === "boolean") {
        update.selfImproveEnabled = data.selfImproveEnabled;
      }
      if ("selfImproveAutoApprove" in data && typeof data.selfImproveAutoApprove === "boolean") {
        update.selfImproveAutoApprove = data.selfImproveAutoApprove;
      }
      if ("selfImproveMaxPerWeek" in data && typeof data.selfImproveMaxPerWeek === "number") {
        update.selfImproveMaxPerWeek = data.selfImproveMaxPerWeek;
      }
    } else {
      // Individual field overrides
      update = {};
      for (const key of BRAIN_CONFIG_ALLOWED_KEYS) {
        if (key in data && key !== "preset") {
          (update as Record<string, unknown>)[key] = data[key];
        }
      }
      update.preset = null;
    }

    const config = saveBrainConfig(update);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      config,
      activePreset: getActivePreset(config),
      presets: BRAIN_PRESETS,
      characterPresets: CHARACTER_PRESETS,
    }));
  } catch (err) {
    log(`Brain config update error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

// ── Twilio handlers ──

async function handleTwilioSaveConfig(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);

    if (!data.accountSid || !data.authToken || !data.phoneNumber || !data.webhookBaseUrl) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "accountSid, authToken, phoneNumber, and webhookBaseUrl are required" }));
      return;
    }

    const config = {
      accountSid: String(data.accountSid),
      authToken: String(data.authToken),
      phoneNumber: String(data.phoneNumber),
      webhookBaseUrl: String(data.webhookBaseUrl).replace(/\/+$/, ""),
      defaultVoice: String(data.defaultVoice || "Polly.Lotte"),
      defaultLanguage: String(data.defaultLanguage || "nl-NL"),
      maxCallDurationSec: Number(data.maxCallDurationSec) || 600,
      model: String(data.model || "claude-sonnet-4-20250514"),
    };

    saveTwilioConfig(config);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, status: getTwilioStatus() }));
  } catch (err) {
    log(`Twilio config save error: ${err}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

async function handleTwilioCall(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body);
    const { to, mode, message, systemPrompt, greeting, voice, language, model } = data;

    if (!to) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "to is required" }));
      return;
    }

    if (mode === "agent") {
      const record = await makeAgentCall(
        to,
        systemPrompt || "You are ARIA, a helpful AI assistant making a phone call. Be concise and natural.",
        greeting || "Hello, this is ARIA calling.",
        voice,
        language,
        model,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record));
    } else {
      if (!message) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "message is required for simple calls" }));
        return;
      }
      const record = await makeSimpleCall(to, message, voice, language);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(record));
    }
  } catch (err) {
    log(`Twilio call error: ${err}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}
