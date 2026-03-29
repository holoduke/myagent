import { IncomingMessage, ServerResponse } from "http";
import { resetSession } from "../claude.js";
import { getDefaultProvider } from "../providers/index.js";
import { MessageQueue } from "../queue.js";
import { getHistory, addMessage, clearHistory, getUsageStats, getUsageData } from "../history.js";
import { getWhatsAppStatus } from "../integrations/whatsapp.js";
import { getScheduledMessages } from "../scheduler.js";
import { getWhitelist } from "../contact-whitelist.js";
import { getAccountStatus } from "../integrations/gmail.js";
import { getWorkspaceStatus } from "../integrations/slack.js";
import { getSSHStatus } from "../integrations/ssh.js";
import { getCalendarStatus } from "../integrations/calendar.js";
import { getHAStatus } from "../integrations/homeassistant.js";
import { getRSSStatus } from "../integrations/rss.js";
import { getOwnTracksStatus } from "../integrations/owntracks.js";
import { getTwilioStatus } from "../integrations/twilio.js";
import { getBrowserStatus } from "../integrations/browser.js";
import { getIntegrationsConfig } from "../integrations/integration-config.js";
import { getRecentAuditEntries } from "../action-verifier.js";
import { isAuthenticated, readBody } from "./auth.js";
import { respondJson } from "../utils/api-helpers.js";
import { createLogger } from "../logger.js";
import { getAriaStatus, getMoltbookStatus } from "./brain-api.js";

const log = createLogger("web");

export function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  queue: MessageQueue,
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  // -- Auth check (no auth needed) --
  if (pathname === "/api/auth-check") {
    respondJson(res, 200, { authenticated: isAuthenticated(req) });
    return true;
  }

  // -- Chat SSE (not wrapped -- uses SSE streaming) --
  if (pathname === "/api/chat" && req.method === "POST") {
    if (!isAuthenticated(req)) {
      respondJson(res, 401, { error: "Unauthorized" });
      return true;
    }
    handleChat(req, res, queue);
    return true;
  }

  // -- History (with optional pagination) --
  if (pathname === "/api/history" && isAuthenticated(req)) {
    const historyUrl = new URL(req.url || "/", "http://localhost");
    const limit = Math.min(parseInt(historyUrl.searchParams.get("limit") || "200", 10) || 200, 1000);
    const offset = Math.max(parseInt(historyUrl.searchParams.get("offset") || "0", 10) || 0, 0);
    const history = getHistory();
    respondJson(res, 200, history.slice(offset, offset + limit));
    return true;
  }

  // -- ARIA status (full brain/graph data) --
  if (pathname === "/api/aria/status" && isAuthenticated(req)) {
    respondJson(res, 200, getAriaStatus());
    return true;
  }

  // -- Dashboard composite endpoint --
  if (pathname === "/api/dashboard" && isAuthenticated(req)) {
    respondJson(res, 200, getDashboardData(queue));
    return true;
  }

  // -- Scheduled messages --
  if (pathname === "/api/scheduled" && isAuthenticated(req)) {
    respondJson(res, 200, getScheduledMessages());
    return true;
  }

  // -- Action Audit Log --
  if (pathname === "/api/audit" && isAuthenticated(req)) {
    const auditUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const parsed = parseInt(auditUrl.searchParams.get("limit") || "50", 10);
    const limit = Number.isNaN(parsed) ? 50 : Math.min(parsed, 200);
    respondJson(res, 200, getRecentAuditEntries(limit));
    return true;
  }

  return false;
}

// -- Dashboard composite data --

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

// -- Chat SSE handler (not wrapped -- uses SSE streaming) --

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
    }, 5000);

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
