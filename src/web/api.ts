import { IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { askClaudeStreaming, resetSession } from "../claude.js";
import { MessageQueue } from "../queue.js";
import { getHistory, addMessage, clearHistory, getUsageStats } from "../history.js";
import { syncContacts, findContacts, getAllContacts, getWhatsAppStatus } from "../whatsapp.js";
import { getScheduledMessages } from "../scheduler.js";
import { getWhitelist, addToWhitelist, removeFromWhitelist } from "../contact-whitelist.js";
import { getAccountStatus, addAccount, removeAccount } from "../gmail.js";
import { getLatestQr } from "../whatsapp.js";
import { getSSHStatus, getPublicKey, addTarget, removeTarget, testConnection } from "../ssh.js";
import { getCalendarStatus } from "../calendar.js";
import { getHAStatus } from "../homeassistant.js";
import { getRSSStatus, addFeed, removeFeed } from "../rss.js";
import { getOwnTracksStatus } from "../owntracks.js";
import { isAuthenticated, readBody } from "./auth.js";
import type { MemoryNode, MemoryEdge } from "../memory/types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [web] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

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

  // ── Home Assistant status ──
  if (pathname === "/api/homeassistant/status" && req.method === "GET" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getHAStatus()));
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

  return false;
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
    whitelistCount: whitelist.length,
    scheduledCount: scheduled.length,
    queueDepth: queue.size,
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
      const nodes = JSON.parse(readFileSync(nf, "utf-8")) as Record<string, MemoryNode>;
      const nodeList = Object.values(nodes);
      const edges: MemoryEdge[] = existsSync(ef) ? JSON.parse(readFileSync(ef, "utf-8")) : [];

      const byType: Record<string, number> = {};
      let totalStrength = 0;
      for (const n of nodeList) {
        byType[n.type] = (byType[n.type] || 0) + 1;
        totalStrength += n.strength;
      }

      const pinned = nodeList.filter(n => n.pinned).sort((a, b) => b.strength - a.strength);
      const strongest = nodeList
        .filter(n => !n.pinned)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 20);
      const weakest = nodeList
        .filter(n => !n.pinned && n.strength < 0.2)
        .sort((a, b) => a.strength - b.strength)
        .slice(0, 10);
      const recent = [...nodeList]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

      status.graph = {
        nodeCount: nodeList.length,
        edgeCount: edges.length,
        byType,
        avgStrength: nodeList.length > 0 ? totalStrength / nodeList.length : 0,
        pinnedNodes: pinned.map(n => ({ id: n.id, type: n.type, content: n.content, tags: n.tags, strength: n.strength })),
        strongestNodes: strongest.map(n => ({ id: n.id, type: n.type, content: n.content, tags: n.tags, strength: n.strength, accessCount: n.accessCount })),
        weakestNodes: weakest.map(n => ({ id: n.id, type: n.type, content: n.content, strength: n.strength })),
        recentNodes: recent.map(n => ({ id: n.id, type: n.type, content: n.content, tags: n.tags, strength: n.strength, createdAt: n.createdAt })),
      };
    }
  } catch {}

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

        let fullResponse = "";
        const result = await askClaudeStreaming(message, (delta) => {
          fullResponse += delta;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`);
          }
        });

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
    const uri = redirectUri || `${req.headers.origin || "http://localhost:3000"}/gmail/auth/${id}/callback`;
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
