import { IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { resetSession } from "../claude.js";
import { getDefaultProvider } from "../providers/index.js";
import { MessageQueue } from "../queue.js";
import { getHistory, addMessage, clearHistory, getUsageStats, getUsageData } from "../history.js";
import { syncContacts, findContacts, getAllContacts, getWhatsAppStatus, sendImage } from "../integrations/whatsapp.js";
import { getScheduledMessages } from "../scheduler.js";
import { getWhitelist, addToWhitelist, removeFromWhitelist, updatePermissions } from "../contact-whitelist.js";
import type { ContactPermissions } from "../contact-whitelist.js";
import { getActionableRequests, approveRequest, rejectRequest, getPendingCount } from "../actionable-tracker.js";
import type { ActionableRequestStatus } from "../actionable-tracker.js";
import { getDirectives, getDirectivesForContact, addDirective, updateDirective, removeDirective } from "../directives.js";
import type { DirectiveActionType, DirectivePolicy } from "../directives.js";
import { getRequests as getContactRequests, approveRequest as approveContactRequest, rejectRequest as rejectContactRequest, getPendingRequestCount } from "../request-queue.js";
import type { RequestStatus } from "../request-queue.js";
import { getAccountStatus, addAccount, removeAccount } from "../integrations/gmail.js";
import { getWorkspaceStatus, addWorkspace as addSlackWorkspace, removeWorkspace as removeSlackWorkspace } from "../integrations/slack.js";
import { getLatestQr } from "../integrations/whatsapp.js";
import { getSSHStatus, getPublicKey, addTarget, removeTarget, testConnection } from "../integrations/ssh.js";
import { getCalendarStatus, createEvent } from "../integrations/calendar.js";
import { getHAStatus, saveConfig, restartHAPolling, testHAConnection } from "../integrations/homeassistant.js";
import type { HAConfig, HAConnectionMode } from "../integrations/homeassistant.js";
import { getRSSStatus, addFeed, removeFeed } from "../integrations/rss.js";
import { getOwnTracksStatus } from "../integrations/owntracks.js";
import { getTwilioStatus, makeSimpleCall, makeAgentCall, saveConfig as saveTwilioConfig, loadCallHistory } from "../integrations/twilio.js";
import { getBrowserStatus, clearBrowserHistory, runWorkflow, runSession, navigateTo, takeScreenshot, extractText } from "../integrations/browser.js";
import { requestCaptchaVerification, getPendingCaptchas, getCaptchaHistory } from "../captcha-verify.js";
import { getIntegrationsConfig, saveIntegrationsConfig, isValidIntegrationKey } from "../integrations/integration-config.js";
import { getTrustConfig, saveTrustConfig } from "../trust.js";
import type { TrustConfig } from "../trust.js";
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
import { getRecentAuditEntries } from "../action-verifier.js";
import { GoalTracker } from "../goals.js";
import { MemoryGraph } from "../memory/graph.js";
import { loadWorkingMemory } from "../memory/working-memory.js";
import type { GoalData, RetentionTier } from "../memory/types.js";
import { classifyRetentionTier } from "../memory/decay.js";
import { createLogger } from "../logger.js";
import { respondJson, apiHandler, apiGetHandler, ApiError } from "../utils/api-helpers.js";

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
    respondJson(res, 200, { authenticated: isAuthenticated(req) });
    return true;
  }

  // ── Chat SSE (not wrapped — uses SSE streaming) ──
  if (pathname === "/api/chat" && req.method === "POST") {
    if (!isAuthenticated(req)) {
      respondJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    handleChat(req, res, queue);
    return true;
  }

  // ── History ──
  if (pathname === "/api/history" && isAuthenticated(req)) {
    respondJson(res, 200, getHistory());
    return true;
  }

  // ── ARIA status (full brain/graph data) ──
  if (pathname === "/api/aria/status" && isAuthenticated(req)) {
    respondJson(res, 200, getAriaStatus());
    return true;
  }

  // ── Dashboard composite endpoint ──
  if (pathname === "/api/dashboard" && isAuthenticated(req)) {
    respondJson(res, 200, getDashboardData(queue));
    return true;
  }

  // ── Scheduled messages ──
  if (pathname === "/api/scheduled" && isAuthenticated(req)) {
    respondJson(res, 200, getScheduledMessages());
    return true;
  }

  // ── Action Audit Log ──
  if (pathname === "/api/audit" && isAuthenticated(req)) {
    const auditUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const parsed = parseInt(auditUrl.searchParams.get("limit") || "50", 10);
    const limit = Number.isNaN(parsed) ? 50 : Math.min(parsed, 200);
    respondJson(res, 200, getRecentAuditEntries(limit));
    return true;
  }

  // ── Whitelist Permissions ──
  if (pathname === "/api/whitelist/permissions" && req.method === "PUT" && isAuthenticated(req)) {
    handleWhitelistPermissions(req, res);
    return true;
  }

  // ── Whitelist CRUD ──
  if (pathname === "/api/whitelist" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getWhitelist());
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

  // ── Actionable Requests ──
  if (pathname === "/api/actionable-requests" && req.method === "GET" && isAuthenticated(req)) {
    const statusFilter = url.searchParams.get("status") as ActionableRequestStatus | null;
    respondJson(res, 200, getActionableRequests(statusFilter || undefined));
    return true;
  }
  if (pathname === "/api/actionable-requests/pending-count" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { count: getPendingCount() });
    return true;
  }
  if (req.method === "POST" && isAuthenticated(req)) {
    const approveMatch = pathname.match(/^\/api\/actionable-requests\/([^/]+)\/approve$/);
    if (approveMatch) {
      try {
        const result = approveRequest(approveMatch[1]);
        respondJson(res, 200, result);
      } catch (err) {
        respondJson(res, 400, { error: String(err) });
      }
      return true;
    }
    const rejectMatch = pathname.match(/^\/api\/actionable-requests\/([^/]+)\/reject$/);
    if (rejectMatch) {
      try {
        const result = rejectRequest(rejectMatch[1]);
        respondJson(res, 200, result);
      } catch (err) {
        respondJson(res, 400, { error: String(err) });
      }
      return true;
    }
  }

  // ── Directives ──
  if (pathname === "/api/directives" && isAuthenticated(req)) {
    if (req.method === "GET") {
      const contactJid = url.searchParams.get("contactJid");
      respondJson(res, 200, contactJid ? getDirectivesForContact(contactJid) : getDirectives());
      return true;
    }
    if (req.method === "POST") {
      handleDirectiveAdd(req, res);
      return true;
    }
  }
  if (req.method === "PATCH" && isAuthenticated(req)) {
    const directiveMatch = pathname.match(/^\/api\/directives\/([^/]+)$/);
    if (directiveMatch) {
      handleDirectiveUpdate(req, res, directiveMatch[1]);
      return true;
    }
  }
  if (req.method === "DELETE" && isAuthenticated(req)) {
    const directiveDeleteMatch = pathname.match(/^\/api\/directives\/([^/]+)$/);
    if (directiveDeleteMatch) {
      const removed = removeDirective(directiveDeleteMatch[1]);
      respondJson(res, removed ? 200 : 404, { success: removed });
      return true;
    }
  }

  // ── Contact Request Queue ──
  if (pathname === "/api/contact-requests" && req.method === "GET" && isAuthenticated(req)) {
    const statusFilter = url.searchParams.get("status") as RequestStatus | null;
    respondJson(res, 200, getContactRequests(statusFilter || undefined));
    return true;
  }
  if (pathname === "/api/contact-requests/pending-count" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { count: getPendingRequestCount() });
    return true;
  }
  if (req.method === "POST" && isAuthenticated(req)) {
    const crApproveMatch = pathname.match(/^\/api\/contact-requests\/([^/]+)\/approve$/);
    if (crApproveMatch) {
      handleContactRequestApprove(req, res, crApproveMatch[1]);
      return true;
    }
    const crRejectMatch = pathname.match(/^\/api\/contact-requests\/([^/]+)\/reject$/);
    if (crRejectMatch) {
      handleContactRequestReject(req, res, crRejectMatch[1]);
      return true;
    }
  }

  // ── Contact sync (not wrapped — uses setTimeout callback pattern) ──
  if (pathname === "/api/sync-contacts" && req.method === "POST" && isAuthenticated(req)) {
    syncContacts()
      .then(() => {
        setTimeout(() => {
          const contacts = getAllContacts();
          respondJson(res, 200, { success: true, contactCount: contacts.length });
        }, 3000);
      })
      .catch((err) => {
        respondJson(res, 500, { error: String(err) });
      });
    return true;
  }

  // ── Contacts search ──
  if (pathname === "/api/contacts" && isAuthenticated(req)) {
    const query = url.searchParams.get("q");
    const contacts = query ? findContacts(query) : getAllContacts();
    respondJson(res, 200, contacts);
    return true;
  }

  // ── SSH public key ──
  if (pathname === "/api/ssh/public-key" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, { publicKey: getPublicKey() });
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

  // ── Slack workspace CRUD ──
  if (pathname === "/api/slack/workspaces" && isAuthenticated(req)) {
    if (req.method === "POST") {
      handleSlackAddWorkspace(req, res);
      return true;
    }
    if (req.method === "DELETE") {
      handleSlackRemoveWorkspace(req, res);
      return true;
    }
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
    respondJson(res, 200, { qr: getLatestQr() });
    return true;
  }

  // ── Calendar status ──
  if (pathname === "/api/calendar/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getCalendarStatus());
    return true;
  }

  // ── Calendar event creation ──
  if (pathname === "/api/calendar/events" && req.method === "POST" && isAuthenticated(req)) {
    handleCalendarCreateEvent(req, res);
    return true;
  }

  // ── Home Assistant config CRUD ──
  if (pathname === "/api/homeassistant/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getHAStatus());
    return true;
  }

  if (pathname === "/api/homeassistant/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getHAStatus());
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
      respondJson(res, 200, getRSSStatus());
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
    respondJson(res, 200, getOwnTracksStatus());
    return true;
  }

  // ── Twilio voice calling ──
  if (pathname === "/api/twilio/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getTwilioStatus());
    return true;
  }

  if (pathname === "/api/twilio/config" && isAuthenticated(req)) {
    if (req.method === "GET") {
      respondJson(res, 200, getTwilioStatus());
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
    respondJson(res, 200, loadCallHistory());
    return true;
  }

  // ── Browser automation ──
  if (pathname === "/api/browser/status" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getBrowserStatus());
    return true;
  }

  if (pathname === "/api/browser/run" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserRun(req, res);
    return true;
  }

  if (pathname === "/api/browser/session" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserSession(req, res);
    return true;
  }

  if (pathname === "/api/browser/navigate" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserNavigate(req, res);
    return true;
  }

  if (pathname === "/api/browser/screenshot" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserScreenshot(req, res);
    return true;
  }

  if (pathname === "/api/browser/extract" && req.method === "POST" && isAuthenticated(req)) {
    handleBrowserExtract(req, res);
    return true;
  }

  if (pathname === "/api/browser/history" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getBrowserStatus().recentTasks);
    return true;
  }

  if (pathname === "/api/browser/history" && req.method === "DELETE" && isAuthenticated(req)) {
    clearBrowserHistory();
    respondJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === "/api/browser/captcha" && req.method === "POST" && isAuthenticated(req)) {
    handleCaptchaShare(req, res);
    return true;
  }

  if (pathname === "/api/browser/captcha/verify" && req.method === "POST" && isAuthenticated(req)) {
    handleCaptchaVerify(req, res);
    return true;
  }

  if (pathname === "/api/browser/captcha/pending" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getPendingCaptchas());
    return true;
  }

  if (pathname === "/api/browser/captcha/history" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getCaptchaHistory());
    return true;
  }

  // ── Integrations config ──
  if (pathname === "/api/integrations/config" && req.method === "PUT" && isAuthenticated(req)) {
    handleIntegrationsConfigUpdate(req, res);
    return true;
  }

  // ── Trust / Security config ──
  if (pathname === "/api/trust/config" && req.method === "GET" && isAuthenticated(req)) {
    respondJson(res, 200, getTrustConfig());
    return true;
  }
  if (pathname === "/api/trust/config" && req.method === "PUT" && isAuthenticated(req)) {
    handleTrustConfigUpdate(req, res);
    return true;
  }
  if (pathname === "/api/trust/injection-log" && req.method === "GET" && isAuthenticated(req)) {
    handleInjectionLogGet(req, res);
    return true;
  }

  // ── Improve queue ──
  if (pathname === "/api/improve-queue" && req.method === "GET" && isAuthenticated(req)) {
    handleImproveQueueGet(req, res);
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+\/approve$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    handleImproveQueueAction(req, res, () => approveItem(id));
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+\/reject$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    handleImproveQueueAction(req, res, () => { rejectItem(id); return { ok: true }; });
    return true;
  }

  if (pathname.match(/^\/api\/improve-queue\/[^/]+$/) && req.method === "DELETE" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
    handleImproveQueueAction(req, res, () => { deleteItem(id); return { ok: true }; });
    return true;
  }

  // ── Brain dashboard (composite) ──
  if (pathname === "/api/brain/dashboard" && req.method === "GET" && isAuthenticated(req)) {
    handleBrainDashboardGet(req, res);
    return true;
  }

  // ── Brain recurring tasks CRUD ──
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
    const id = pathname.split("/")[4];
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

  // ── Brain goals CRUD ──
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
    handleBrainSignalsGet(req, res);
    return true;
  }

  // ── Brain follow-ups (read-only) ──
  if (pathname === "/api/brain/follow-ups" && req.method === "GET" && isAuthenticated(req)) {
    handleBrainFollowUpsGet(req, res);
    return true;
  }

  // ── Memory node relationships ──
  if (pathname.match(/^\/api\/memory\/node\/[^/]+\/relationships$/) && req.method === "GET" && isAuthenticated(req)) {
    const nodeId = pathname.split("/")[4];
    handleMemoryNodeRelationships(req, res, nodeId);
    return true;
  }

  // ── Brain config ──
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

  // ── Sub-Agents CRUD ──
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
    const id = decodeURIComponent(subAgentMatch[1]);
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
    const id = pathname.split("/")[3];
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
    const id = pathname.split("/")[3];
    respondJson(res, 200, loadSubAgentHistory(id));
    return true;
  }

  if (pathname.match(/^\/api\/sub-agents\/[^/]+\/run$/) && req.method === "POST" && isAuthenticated(req)) {
    const id = pathname.split("/")[3];
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
        markRunning(id, undefined);
        const child = spawn("npx", ["tsx", "backend/sub-agent-worker.ts", id], {
          detached: true, stdio: "ignore", cwd: "/app", env: { ...process.env },
        });
        child.unref();
        respondJson(res, 200, { ok: true, message: "Run triggered" });
      }
    }
    return true;
  }

  return false;
}

// ── Sub-Agent handlers ──

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

// ── Dashboard composite data ──
// ── Moltbook status (cached, refreshed in background) ──
const MOLTBOOK_CREDS = "/data/moltbook/credentials.json";
const MOLTBOOK_CACHE_MS = 5 * 60 * 1000; // 5 min
let moltbookCache: {
  enabled: boolean; name: string; profileUrl: string;
  karma: number; followers: number; postCount: number; lastActive: string | null;
} = { enabled: false, name: "", profileUrl: "", karma: 0, followers: 0, postCount: 0, lastActive: null };
let moltbookLastFetch = 0;

function getMoltbookStatus() {
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
    slack: (() => {
      const slackWorkspaces = getWorkspaceStatus();
      return {
        total: slackWorkspaces.length,
        authenticated: slackWorkspaces.filter(w => w.authenticated).length,
      };
    })(),
    slackWorkspaces: getWorkspaceStatus(),
    ssh,
    calendar: getCalendarStatus(),
    homeassistant: getHAStatus(),
    rss: getRSSStatus(),
    owntracks: getOwnTracksStatus(),
    twilio: getTwilioStatus(),
    browser: getBrowserStatus(),
    moltbook: getMoltbookStatus(),
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

// ── Chat SSE handler (not wrapped — uses SSE streaming) ──
async function handleChat(req: IncomingMessage, res: ServerResponse, queue: MessageQueue) {
  try {
    const body = await readBody(req);
    const { message } = JSON.parse(body);

    if (!message?.trim()) {
      respondJson(res, 400, { error: "Message is required" });
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

const handleWhitelistAdd = apiHandler(async (_req, _res, body: { jid?: string; name?: string }) => {
  if (!body.jid || !body.name) throw new ApiError(400, "jid and name are required");
  addToWhitelist(body.jid, body.name);
  return { success: true };
});

const handleWhitelistRemove = apiHandler(async (_req, _res, body: { jid?: string }) => {
  if (!body.jid) throw new ApiError(400, "jid is required");
  return { success: removeFromWhitelist(body.jid) };
});

const handleWhitelistPermissions = apiHandler(async (_req, _res, body: { jid?: string; permissions?: ContactPermissions | null }) => {
  if (!body.jid) throw new ApiError(400, "jid is required");
  const ok = updatePermissions(body.jid, body.permissions ?? null);
  if (!ok) throw new ApiError(404, "Contact not found on whitelist");
  return { success: true };
});

// ── SSH handlers ──

const handleSSHAddTarget = apiHandler(async (_req, _res, body: { label?: string; host?: string; user?: string; port?: number }) => {
  if (!body.label || !body.host || !body.user) throw new ApiError(400, "label, host, and user are required");
  const target = addTarget(body.label, body.host, body.user, body.port || 22);
  return { success: true, target };
});

const handleSSHRemoveTarget = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeTarget(body.id) };
});

const handleSSHTest = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return await testConnection(body.id);
});

// ── Slack handlers ──

const handleSlackAddWorkspace = apiHandler(async (req, _res, body: { id?: string; teamName?: string; clientId?: string; clientSecret?: string; redirectUri?: string }) => {
  if (!body.id || !body.teamName || !body.clientId || !body.clientSecret) {
    throw new ApiError(400, "id, teamName, clientId, and clientSecret are required");
  }
  const uri = body.redirectUri || `${req.headers.origin || "http://localhost:3000"}/slack/callback`;
  const workspace = addSlackWorkspace(body.id, body.teamName, body.clientId, body.clientSecret, uri);
  return { success: true, workspace: { id: workspace.id, teamName: workspace.teamName } };
});

const handleSlackRemoveWorkspace = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeSlackWorkspace(body.id) };
});

// ── Gmail handlers ──

const handleGmailAddAccount = apiHandler(async (req, _res, body: { id?: string; email?: string; clientId?: string; clientSecret?: string; redirectUri?: string }) => {
  if (!body.id || !body.email || !body.clientId || !body.clientSecret) {
    throw new ApiError(400, "id, email, clientId, and clientSecret are required");
  }
  const uri = body.redirectUri || `${req.headers.origin || "http://localhost:3000"}/gmail/callback`;
  const account = addAccount(body.id, body.email, body.clientId, body.clientSecret, uri);
  return { success: true, account: { id: account.id, email: account.email } };
});

const handleGmailRemoveAccount = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeAccount(body.id) };
});

// ── Calendar handler ──

const handleCalendarCreateEvent = apiHandler(async (_req, res, body: { accountId?: string; summary?: string; startDateTime?: string; endDateTime?: string; location?: string }) => {
  if (!body.accountId || !body.summary || !body.startDateTime || !body.endDateTime) {
    throw new ApiError(400, "Missing required fields: accountId, summary, startDateTime, endDateTime");
  }
  const result = await createEvent(body.accountId, body.summary, body.startDateTime, body.endDateTime, body.location);
  respondJson(res, result.success ? 200 : 500, result);
});

// ── RSS handlers ──

const handleRSSAddFeed = apiHandler(async (_req, _res, body: { name?: string; url?: string }) => {
  if (!body.name || !body.url) throw new ApiError(400, "name and url are required");
  const feed = addFeed(body.name.trim(), body.url.trim());
  return { success: true, feed };
});

const handleRSSRemoveFeed = apiHandler(async (_req, _res, body: { id?: string }) => {
  if (!body.id) throw new ApiError(400, "id is required");
  return { success: removeFeed(body.id) };
});

// ── Browser handlers ──

const handleBrowserRun = apiHandler(async (_req, _res, body: Record<string, unknown>) => {
  const { tasks } = body;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new ApiError(400, "tasks array is required");
  if (tasks.length > 10) throw new ApiError(400, "max 10 tasks per workflow");
  const results = await runWorkflow(tasks);
  return { success: true, results };
});

const handleBrowserSession = apiHandler(async (_req, _res, body: Record<string, unknown>) => {
  const { tasks, sessionTimeoutMs } = body;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new ApiError(400, "tasks array is required");
  if (tasks.length > 20) throw new ApiError(400, "max 20 tasks per session");
  const results = await runSession(tasks, sessionTimeoutMs as number | undefined);
  return { success: true, results };
});

const handleBrowserNavigate = apiHandler(async (_req, _res, body: { url?: string }) => {
  if (!body.url) throw new ApiError(400, "url is required");
  return await navigateTo(body.url);
});

const handleBrowserScreenshot = apiHandler(async (_req, _res, body: { url?: string }) => {
  if (!body.url) throw new ApiError(400, "url is required");
  return await takeScreenshot(body.url);
});

const handleBrowserExtract = apiHandler(async (_req, _res, body: { url?: string; selector?: string }) => {
  if (!body.url || !body.selector) throw new ApiError(400, "url and selector are required");
  return await extractText(body.url, body.selector);
});

// ── Captcha handlers ──

const handleCaptchaShare = apiHandler(async (_req, res, body: { url?: string; selector?: string; jid?: string; caption?: string }) => {
  if (!body.url) throw new ApiError(400, "url is required");

  let result;
  if (body.selector) {
    result = await runWorkflow([
      { id: `captcha_nav_${Date.now()}`, type: "navigate", url: body.url },
      { id: `captcha_ss_${Date.now()}`, type: "screenshot", url: body.url },
    ]);
    result = result[result.length - 1];
  } else {
    result = await takeScreenshot(body.url);
  }

  if (!result.success || !result.screenshotPath) {
    respondJson(res, 500, { error: result.error || "Screenshot failed", result });
    return;
  }

  const targetJid = body.jid || (process.env.OWNER_PHONE ? `${process.env.OWNER_PHONE}@s.whatsapp.net` : "");
  if (targetJid) {
    await sendImage(targetJid, result.screenshotPath, body.caption || "captcha screenshot");
  }

  return {
    ok: true,
    screenshotPath: result.screenshotPath,
    sentTo: targetJid || null,
    url: result.url,
  };
});

const handleCaptchaVerify = apiHandler(async (_req, _res, body: { imagePath?: string; caption?: string; timeout?: number }) => {
  if (!body.imagePath) throw new ApiError(400, "imagePath is required");
  const answer = await requestCaptchaVerification(body.imagePath, body.caption || undefined, body.timeout || 300_000);
  return { ok: true, answer };
});

// ── Integrations config handler ──

const handleIntegrationsConfigUpdate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  for (const [key, val] of Object.entries(data)) {
    if (!isValidIntegrationKey(key)) throw new ApiError(400, `Unknown integration key: ${key}`);
    if (typeof val !== "boolean") throw new ApiError(400, `Value for "${key}" must be a boolean`);
  }
  return saveIntegrationsConfig(data);
});

// ── Trust config handlers ──

const handleTrustConfigUpdate = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  return saveTrustConfig(data as Partial<TrustConfig>);
});

const handleInjectionLogGet = apiGetHandler(() => {
  const logFile = "/data/brain/injection-attempts.jsonl";
  try {
    if (!existsSync(logFile)) return [];
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-100)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch { return []; }
});

// ── Improve queue handlers ──

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

// ── Brain dashboard handler ──

const handleBrainDashboardGet = apiGetHandler(() => getBrainDashboard());

// ── Brain signals handler ──

const handleBrainSignalsGet = apiGetHandler(() => {
  const graph = new MemoryGraph();
  graph.load();
  const wm = loadWorkingMemory();
  return detectInitiativeSignals(graph, wm);
});

// ── Brain follow-ups handler ──

const handleBrainFollowUpsGet = apiGetHandler(() => {
  const wm = loadWorkingMemory();
  return wm.pendingFollowUps;
});

// ── Brain goals GET handler ──

const handleBrainGoalsGet = apiGetHandler(() => getBrainGoals());

// ── Memory node relationships handler ──

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

// ── Home Assistant handlers ──

const handleHASaveConfig = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  const mode = data.mode as HAConnectionMode;
  if (!mode || !["direct_api", "cloud"].includes(mode)) throw new ApiError(400, "mode must be 'direct_api' or 'cloud'");

  const config: HAConfig = {
    mode,
    entities: Array.isArray(data.entities) ? data.entities : ["light", "switch", "lock", "climate", "binary_sensor", "sensor"],
    pollInterval: typeof data.pollInterval === "number" ? data.pollInterval : 60000,
  };

  if (data.direct_api && typeof data.direct_api === "object") {
    const directApi = data.direct_api as Record<string, unknown>;
    config.direct_api = { url: String(directApi.url || ""), token: String(directApi.token || "") };
  }

  if (data.cloud && typeof data.cloud === "object") {
    const cloud = data.cloud as Record<string, unknown>;
    config.cloud = { url: String(cloud.url || ""), token: String(cloud.token || "") };
  }

  saveConfig(config);
  restartHAPolling();
  return { success: true, status: getHAStatus() };
});

const handleHATestConnection = apiHandler(async (_req, _res, body: { mode?: string; url?: string; token?: string }) => {
  if (!body.mode || !body.url || !body.token) throw new ApiError(400, "mode, url, and token are required");
  return await testHAConnection(body.mode as HAConnectionMode, body.url, body.token);
});

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
      if (key in data && key !== "preset") {
        (update as Record<string, unknown>)[key] = data[key];
      }
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

// ── Twilio handlers ──

const handleTwilioSaveConfig = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  if (!data.accountSid || !data.authToken || !data.phoneNumber || !data.webhookBaseUrl) {
    throw new ApiError(400, "accountSid, authToken, phoneNumber, and webhookBaseUrl are required");
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
  return { success: true, status: getTwilioStatus() };
});

const handleTwilioCall = apiHandler(async (_req, _res, data: Record<string, unknown>) => {
  const { to, mode, message, systemPrompt, greeting, voice, language, model } = data as {
    to?: string; mode?: string; message?: string; systemPrompt?: string;
    greeting?: string; voice?: string; language?: string; model?: string;
  };
  if (!to) throw new ApiError(400, "to is required");

  if (mode === "agent") {
    return await makeAgentCall(
      to,
      systemPrompt || "You are ARIA, a helpful AI assistant making a phone call. Be concise and natural.",
      greeting || "Hello, this is ARIA calling.",
      voice, language, model,
    );
  } else {
    if (!message) throw new ApiError(400, "message is required for simple calls");
    return await makeSimpleCall(to, message, voice, language);
  }
});

// ── Directive handlers ──

const handleDirectiveAdd = apiHandler(async (_req, _res, body: {
  contactJid?: string;
  contactName?: string;
  actionType?: string;
  policy?: string;
  note?: string;
}) => {
  if (!body.contactJid || !body.contactName || !body.actionType || !body.policy) {
    throw new ApiError(400, "contactJid, contactName, actionType, and policy are required");
  }
  return addDirective(
    body.contactJid,
    body.contactName,
    body.actionType as DirectiveActionType,
    body.policy as DirectivePolicy,
    body.note,
  );
});

function handleDirectiveUpdate(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: {
    policy?: DirectivePolicy;
    enabled?: boolean;
    note?: string;
  }) => {
    const result = updateDirective(id, body);
    if (!result) throw new ApiError(404, "Directive not found");
    return result;
  });
  handler(req, res);
}

// ── Contact request handlers ──

function handleContactRequestApprove(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: { note?: string }) => {
    return approveContactRequest(id, body?.note);
  });
  handler(req, res);
}

function handleContactRequestReject(req: IncomingMessage, res: ServerResponse, id: string) {
  const handler = apiHandler(async (_req, _res, body: { note?: string }) => {
    return rejectContactRequest(id, body?.note);
  });
  handler(req, res);
}
