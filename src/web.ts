import { randomBytes } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { askClaudeStreaming, resetSession } from "./claude.js";
import { MessageQueue } from "./queue.js";
import { getHistory, addMessage, clearHistory, getUsageStats } from "./history.js";
import type { MemoryNode, MemoryEdge, BrainState, WorkingMemory } from "./memory/types.js";

const LOG_FILE = process.env.LOG_FILE || "./agent.log";
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [web] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

const activeSessions = new Set<string>();
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function getSessionToken(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (match) return match[1];

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);

  return null;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = getSessionToken(req);
  return token ? activeSessions.has(token) : false;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function handleWebRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  queue: MessageQueue,
): boolean {
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === "/chat") {
    if (!WEB_PASSWORD) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("WEB_PASSWORD not configured");
      return true;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getChatHTML());
    return true;
  }

  if (pathname === "/api/login" && req.method === "POST") {
    handleLogin(req, res);
    return true;
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }
    handleChat(req, res, queue);
    return true;
  }

  if (pathname === "/api/history" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getHistory()));
    return true;
  }

  if (pathname === "/api/auth-check") {
    const ok = isAuthenticated(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: ok }));
    return true;
  }

  // ── ARIA Dashboard ──
  if (pathname === "/aria") {
    if (!WEB_PASSWORD) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("WEB_PASSWORD not configured");
      return true;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getAriaHTML());
    return true;
  }

  if (pathname === "/api/aria/status" && isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getAriaStatus()));
    return true;
  }

  return false;
}

async function handleLogin(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req);
    const { password } = JSON.parse(body);

    if (password === WEB_PASSWORD) {
      const token = generateToken();
      activeSessions.add(token);
      log(`Login successful, token: ${token.slice(0, 8)}...`);

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      });
      res.end(JSON.stringify({ success: true, token }));
    } else {
      log("Login failed: wrong password");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid password" }));
    }
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
  }
}

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

    // Heartbeat to keep connection alive during long tool executions
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`:heartbeat\n\n`);
    }, 15000);

    try {
      await queue.add(async () => {
        if (res.writableEnded) return;

        // Handle /reset command
        if (message.trim().toLowerCase() === "/reset") {
          resetSession();
          clearHistory();
          res.write(`data: ${JSON.stringify({ type: "delta", text: "Session reset. Starting fresh conversation." })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          return;
        }

        // Handle /usage command
        if (message.trim().toLowerCase() === "/usage") {
          const stats = getUsageStats();
          res.write(`data: ${JSON.stringify({ type: "delta", text: stats })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          return;
        }

        // Save user message to history
        addMessage({ role: "user", content: message, timestamp: Date.now(), source: "web" });

        res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);

        let fullResponse = "";
        const result = await askClaudeStreaming(message, (delta) => {
          fullResponse += delta;
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`);
          }
        });

        // Save assistant response to history
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

// ── ARIA Status Data ──

const BRAIN_DIR = process.env.BRAIN_DIR || "/data/brain";

function getAriaStatus() {
  const status: Record<string, unknown> = {};

  // Brain state
  try {
    const f = `${BRAIN_DIR}/state.json`;
    if (existsSync(f)) status.brainState = JSON.parse(readFileSync(f, "utf-8"));
  } catch {}

  // Working memory
  try {
    const f = `${BRAIN_DIR}/working-memory.json`;
    if (existsSync(f)) status.workingMemory = JSON.parse(readFileSync(f, "utf-8"));
  } catch {}

  // Graph stats + nodes
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

  // Self-improve status
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

// ── ARIA Dashboard HTML ──

function getAriaHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b0b14">
  <title>ARIA — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html{height:100%;-webkit-text-size-adjust:100%}
    body{font-family:'Inter',system-ui,sans-serif;background:#0b0b14;color:#d4d4d8;min-height:100vh}

    /* Login (reuse chat style) */
    #login{display:flex;justify-content:center;align-items:center;height:100vh;
      flex-direction:column;background:radial-gradient(ellipse at 50% 0%,#1a1a30 0%,#0b0b14 70%)}
    .login-card{background:#12121f;border:1px solid #1e1e35;border-radius:20px;padding:44px 36px;
      width:min(380px,90vw);text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .login-card h1{font-size:28px;font-weight:700;
      background:linear-gradient(135deg,#d4a574,#e8c9a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .login-card .subtitle{color:#3f3f5c;font-size:13px;margin:8px 0 28px;letter-spacing:.4px}
    .login-card input{width:100%;padding:13px 16px;border-radius:12px;border:1px solid #1e1e35;
      background:#0b0b14;color:#d4d4d8;font-size:15px;font-family:inherit;outline:none;transition:all .2s}
    .login-card input:focus{border-color:#d4a574;box-shadow:0 0 0 3px rgba(212,165,116,.1)}
    .login-card button{width:100%;padding:13px;border-radius:12px;border:none;margin-top:16px;
      background:linear-gradient(135deg,#d4a574,#c4915e);color:#0b0b14;font-size:15px;
      font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;
      box-shadow:0 4px 12px rgba(212,165,116,.2)}
    .login-card button:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(212,165,116,.3)}
    .login-err{color:#ef4444;font-size:13px;min-height:18px;margin-top:12px}

    /* Dashboard */
    #dash{display:none}
    .dash-hdr{padding:20px 24px 16px;background:rgba(15,15,26,.9);border-bottom:1px solid #1a1a2e;
      display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;
      backdrop-filter:blur(16px)}
    .dash-hdr h1{font-size:22px;font-weight:700;
      background:linear-gradient(135deg,#d4a574,#e8c9a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .dash-hdr .nav{display:flex;gap:8px;align-items:center}
    .dash-hdr .nav a{color:#52525b;text-decoration:none;font-size:13px;padding:6px 12px;
      border-radius:8px;border:1px solid #1e1e35;transition:all .15s}
    .dash-hdr .nav a:hover{color:#d4a574;border-color:#d4a574}
    .status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
    .status-dot.ok{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.4)}
    .status-dot.warn{background:#eab308;box-shadow:0 0 8px rgba(234,179,8,.4)}
    .status-dot.err{background:#ef4444;box-shadow:0 0 8px rgba(239,68,68,.4)}
    #refresh-timer{color:#2e2e45;font-size:11px}

    .dash-body{max-width:1200px;margin:0 auto;padding:20px 16px 40px;display:grid;
      grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}

    /* Cards */
    .card{background:#12121f;border:1px solid #1e1e35;border-radius:16px;padding:20px;overflow:hidden}
    .card.full{grid-column:1/-1}
    .card h2{font-size:14px;font-weight:600;color:#d4a574;margin-bottom:14px;
      letter-spacing:.3px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
    .card h2 svg{width:16px;height:16px;opacity:.7}

    /* Key-Value rows */
    .kv{display:flex;justify-content:space-between;align-items:center;padding:6px 0;
      border-bottom:1px solid #0f0f1a;font-size:13px}
    .kv:last-child{border-bottom:none}
    .kv .k{color:#52525b}
    .kv .v{color:#a1a1aa;font-family:'JetBrains Mono',monospace;font-size:12px}
    .kv .v.good{color:#22c55e}
    .kv .v.warn{color:#eab308}
    .kv .v.bad{color:#ef4444}
    .kv .v.accent{color:#d4a574}

    /* Stat grid */
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;margin-bottom:8px}
    .stat{background:#0b0b14;border-radius:12px;padding:14px;text-align:center}
    .stat .num{font-size:24px;font-weight:700;color:#e4e4e7;font-family:'JetBrains Mono',monospace}
    .stat .label{font-size:11px;color:#3f3f5c;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}

    /* Type badges */
    .type-badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;
      font-weight:500;margin-right:4px}
    .type-badge.person{background:#1a2744;color:#6ea8d4}
    .type-badge.event{background:#2a1a3a;color:#b48ad4}
    .type-badge.insight{background:#1a3a2a;color:#6ad4a8}
    .type-badge.fact{background:#2a2a1a;color:#d4c46a}
    .type-badge.emotion{background:#3a1a2a;color:#d46a8a}
    .type-badge.plan{background:#1a2a3a;color:#6ab4d4}
    .type-badge.meta{background:#2a2a2a;color:#a1a1aa}

    /* Memory nodes list */
    .node{background:#0b0b14;border:1px solid #151525;border-radius:10px;padding:10px 12px;
      margin-bottom:8px;font-size:13px;line-height:1.5}
    .node .node-hdr{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
    .node .str{font-family:'JetBrains Mono',monospace;font-size:11px;color:#3f3f5c}
    .node .str-bar{width:50px;height:4px;background:#151525;border-radius:2px;overflow:hidden;display:inline-block;vertical-align:middle;margin-left:4px}
    .node .str-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,#ef4444,#eab308,#22c55e)}
    .node .content{color:#a1a1aa}
    .node .tags{margin-top:4px}
    .node .tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;
      background:#1a1a2e;color:#52525b;margin-right:3px;margin-bottom:2px}
    .node .pinned-icon{color:#d4a574;font-size:11px}

    /* Working memory */
    .wm-field{background:#0b0b14;border-radius:10px;padding:10px 12px;margin-bottom:8px}
    .wm-field .wm-label{font-size:11px;color:#3f3f5c;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
    .wm-field .wm-val{font-size:13px;color:#a1a1aa;line-height:1.5}

    /* Self-improve */
    .si-task{background:#0b0b14;border:1px solid #1a2a1a;border-radius:10px;padding:12px;margin-bottom:8px}
    .si-task.pending{border-color:#2a2a1a}
    .si-task.success{border-color:#1a2a1a}
    .si-task.failed{border-color:#2a1a1a}
    .si-label{font-size:11px;color:#3f3f5c;text-transform:uppercase;letter-spacing:.5px}
    .si-val{font-size:13px;color:#a1a1aa;margin-top:2px}
    .si-link{color:#6ea8d4;text-decoration:none;font-size:12px}
    .si-link:hover{text-decoration:underline}

    @media(max-width:640px){
      .dash-body{grid-template-columns:1fr;padding:12px 8px 32px}
      .card{padding:16px}
      .stat-grid{grid-template-columns:repeat(2,1fr)}
    }
  </style>
</head>
<body>
  <div id="login">
    <div class="login-card">
      <h1>ARIA</h1>
      <p class="subtitle">Autonomous Reasoning & Insight Agent</p>
      <input type="password" id="pw-input" placeholder="Enter password" autofocus>
      <button onclick="doLogin()">Access Dashboard</button>
      <div class="login-err" id="login-err"></div>
    </div>
  </div>

  <div id="dash">
    <div class="dash-hdr">
      <h1><span class="status-dot" id="status-dot"></span>ARIA</h1>
      <div class="nav">
        <span id="refresh-timer"></span>
        <a href="/chat">Chat</a>
      </div>
    </div>
    <div class="dash-body" id="dash-body">
      <div style="text-align:center;padding:40px;color:#2e2e45">Loading...</div>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('agent_token');
    let refreshInterval;

    document.getElementById('pw-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });

    if (token) {
      fetch('/api/auth-check', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => r.json()).then(d => d.authenticated ? showDash() : resetAuth()).catch(resetAuth);
    }

    function resetAuth() {
      localStorage.removeItem('agent_token'); token = null;
      document.getElementById('login').style.display = 'flex';
      document.getElementById('dash').style.display = 'none';
    }
    function showDash() {
      document.getElementById('login').style.display = 'none';
      document.getElementById('dash').style.display = 'block';
      loadStatus();
      refreshInterval = setInterval(loadStatus, 30000);
    }

    async function doLogin() {
      const pw = document.getElementById('pw-input').value;
      const err = document.getElementById('login-err');
      err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }) });
        const d = await res.json();
        if (d.success) { token = d.token; localStorage.setItem('agent_token', token); showDash(); }
        else err.textContent = d.error || 'Login failed';
      } catch { err.textContent = 'Connection error'; }
    }

    function timeAgo(ts) {
      if (!ts) return 'never';
      const d = Date.now() - ts;
      const s = Math.floor(d/1000), m = Math.floor(s/60), h = Math.floor(m/60), dy = Math.floor(h/24);
      if (s < 60) return s + 's ago';
      if (m < 60) return m + 'm ago';
      if (h < 24) return h + 'h ' + (m%60) + 'm ago';
      return dy + 'd ago';
    }
    function fmtDate(ts) {
      if (!ts) return 'N/A';
      return new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    }

    async function loadStatus() {
      try {
        const res = await fetch('/api/aria/status', { headers: { Authorization: 'Bearer ' + token } });
        if (res.status === 401) { resetAuth(); return; }
        const data = await res.json();
        render(data);
        document.getElementById('refresh-timer').textContent = 'Updated ' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      } catch(e) {
        document.getElementById('dash-body').innerHTML = '<div class="card full"><p style="color:#ef4444">Failed to load: '+e.message+'</p></div>';
      }
    }

    function render(d) {
      const bs = d.brainState || {};
      const wm = d.workingMemory || {};
      const g = d.graph || {};
      const si = d.selfImprove || {};

      // Health dot
      const dot = document.getElementById('status-dot');
      const failures = bs.consecutiveFailures || 0;
      const healthy = failures < 5;
      dot.className = 'status-dot ' + (healthy ? (failures > 0 ? 'warn' : 'ok') : 'err');

      let html = '';

      // ── Overview Card ──
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>Brain Status</h2>';
      html += '<div class="stat-grid">';
      html += stat(g.nodeCount || 0, 'Nodes');
      html += stat(g.edgeCount || 0, 'Edges');
      html += stat(bs.totalThinks || 0, 'Thinks');
      html += stat('$'+(bs.totalCost||0).toFixed(2), 'Cost');
      html += '</div>';
      html += kv('Health', healthy ? (failures > 0 ? 'Degraded ('+failures+' failures)' : 'Healthy') : 'Unhealthy ('+failures+' failures)', healthy ? (failures > 0 ? 'warn' : 'good') : 'bad');
      html += kv('Last Think', timeAgo(bs.lastThinkTick));
      html += kv('Last Consolidate', timeAgo(bs.lastConsolidateTick));
      html += kv('Last Reflect', timeAgo(bs.lastReflectTick));
      html += kv('Last Message Sent', timeAgo(bs.lastMessageTime));
      html += kv('Messages Today', (bs.messagesToday || 0) + '/5');
      html += kv('Pending Self-Mod', bs.pendingSelfMod ? 'Yes' : 'No', bs.pendingSelfMod ? 'warn' : '');
      html += '</div>';

      // ── Working Memory Card ──
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/></svg>Working Memory</h2>';
      if (wm.currentContext || wm.mood || (wm.shortTermTracking && wm.shortTermTracking.length)) {
        if (wm.mood) html += wmField('Mood', wm.mood);
        if (wm.currentContext) html += wmField('Context', wm.currentContext);
        if (wm.shortTermTracking && wm.shortTermTracking.length) html += wmField('Tracking', wm.shortTermTracking.join(', '));
        html += kv('Last Updated', timeAgo(wm.lastUpdated));
      } else {
        html += '<div style="color:#2e2e45;font-size:13px;padding:10px 0">Empty — awaiting first think tick</div>';
      }
      html += '</div>';

      // ── Graph Stats Card ──
      if (g.byType) {
        html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>Memory Graph</h2>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
        for (const [type, count] of Object.entries(g.byType)) {
          html += '<span class="type-badge '+type+'">'+type+': '+count+'</span>';
        }
        html += '</div>';
        html += kv('Avg Strength', (g.avgStrength||0).toFixed(3));
        html += kv('Pinned Nodes', (g.pinnedNodes||[]).length);
        html += '</div>';
      }

      // ── Self-Improve Card ──
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Self-Improvement</h2>';
      html += kv('Boot Counter', si.bootCounter || 0, si.bootCounter > 1 ? 'warn' : '');
      html += kv('Last Good Commit', si.lastGoodCommit ? si.lastGoodCommit.slice(0,8) : 'none');
      if (si.pendingTask) {
        html += '<div class="si-task pending" style="margin-top:10px">';
        html += '<div class="si-label">Pending Task</div>';
        html += '<div class="si-val">'+esc(si.pendingTask.description)+'</div>';
        html += '<div style="font-size:11px;color:#3f3f5c;margin-top:4px">Files: '+(si.pendingTask.files||[]).join(', ')+'</div>';
        html += '</div>';
      }
      if (si.lastResult) {
        const r = si.lastResult;
        html += '<div class="si-task '+(r.success?'success':'failed')+'" style="margin-top:10px">';
        html += '<div class="si-label">Last Result — '+(r.success?'<span style="color:#22c55e">Success</span>':'<span style="color:#ef4444">Failed</span>')+'</div>';
        html += '<div class="si-val">'+esc(r.description)+'</div>';
        if (r.prUrl) html += '<a class="si-link" href="'+esc(r.prUrl)+'" target="_blank">View PR</a>';
        if (r.completedAt) html += '<div style="font-size:11px;color:#3f3f5c;margin-top:4px">'+fmtDate(r.completedAt)+'</div>';
        html += '</div>';
      }
      if (!si.pendingTask && !si.lastResult) {
        html += '<div style="color:#2e2e45;font-size:13px;padding:10px 0">No self-improvement activity yet</div>';
      }
      html += '</div>';

      // ── Pinned Memories Card ──
      if (g.pinnedNodes && g.pinnedNodes.length) {
        html += '<div class="card full"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 01-1.11-1.65l-.54-4.81A1 1 0 018.34 3h7.32a1 1 0 01.99 1.1l-.54 5.01A2 2 0 0115 10.76L12 14l-3-3.24z"/></svg>Pinned Memories (Core Identity)</h2>';
        for (const n of g.pinnedNodes) html += renderNode(n, true);
        html += '</div>';
      }

      // ── Strongest Memories Card ──
      if (g.strongestNodes && g.strongestNodes.length) {
        html += '<div class="card full"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Strongest Memories</h2>';
        for (const n of g.strongestNodes.slice(0, 10)) html += renderNode(n);
        html += '</div>';
      }

      // ── Recent Memories Card ──
      if (g.recentNodes && g.recentNodes.length) {
        html += '<div class="card full"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Recent Memories</h2>';
        for (const n of g.recentNodes) {
          html += renderNode(n, false, n.createdAt);
        }
        html += '</div>';
      }

      document.getElementById('dash-body').innerHTML = html;
    }

    function stat(val, label) {
      return '<div class="stat"><div class="num">'+val+'</div><div class="label">'+label+'</div></div>';
    }
    function kv(k, v, cls) {
      return '<div class="kv"><span class="k">'+k+'</span><span class="v'+(cls?' '+cls:'')+'">'+v+'</span></div>';
    }
    function wmField(label, val) {
      return '<div class="wm-field"><div class="wm-label">'+label+'</div><div class="wm-val">'+esc(val)+'</div></div>';
    }
    function renderNode(n, pinned, ts) {
      let h = '<div class="node"><div class="node-hdr">';
      h += '<span class="type-badge '+n.type+'">'+n.type+'</span>';
      if (pinned) h += '<span class="pinned-icon">pinned</span>';
      h += '<span class="str">'+n.strength.toFixed(2);
      h += ' <span class="str-bar"><span class="str-fill" style="width:'+(n.strength*100)+'%"></span></span>';
      h += '</span>';
      if (n.accessCount) h += '<span class="str" style="margin-left:auto">'+n.accessCount+' access</span>';
      if (ts) h += '<span class="str" style="margin-left:auto">'+timeAgo(ts)+'</span>';
      h += '</div>';
      h += '<div class="content">'+esc(n.content.slice(0,300))+(n.content.length>300?'...':'')+'</div>';
      if (n.tags && n.tags.length) {
        h += '<div class="tags">';
        for (const t of n.tags) h += '<span class="tag">'+esc(t)+'</span>';
        h += '</div>';
      }
      h += '</div>';
      return h;
    }
    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
}

// ── Chat HTML ──

function getChatHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#0b0b14">
  <title>ARIA</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark-dimmed.min.css">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html{height:100%;-webkit-text-size-adjust:100%}
    body{font-family:'Inter',system-ui,sans-serif;background:#0b0b14;color:#d4d4d8;
      height:100dvh;display:flex;flex-direction:column;overflow:hidden}

    /* ── Login ── */
    #login{display:flex;justify-content:center;align-items:center;height:100dvh;
      flex-direction:column;background:radial-gradient(ellipse at 50% 0%,#1a1a30 0%,#0b0b14 70%)}
    .login-card{background:#12121f;border:1px solid #1e1e35;border-radius:20px;padding:44px 36px;
      width:min(380px,90vw);text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    .login-card h1{font-size:28px;font-weight:700;
      background:linear-gradient(135deg,#d4a574,#e8c9a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .login-card .subtitle{color:#3f3f5c;font-size:13px;margin:8px 0 28px;letter-spacing:.4px}
    .login-card input{width:100%;padding:13px 16px;border-radius:12px;border:1px solid #1e1e35;
      background:#0b0b14;color:#d4d4d8;font-size:15px;font-family:inherit;outline:none;
      transition:all .2s}
    .login-card input:focus{border-color:#d4a574;box-shadow:0 0 0 3px rgba(212,165,116,.1)}
    .login-card button{width:100%;padding:13px;border-radius:12px;border:none;margin-top:16px;
      background:linear-gradient(135deg,#d4a574,#c4915e);color:#0b0b14;font-size:15px;
      font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;
      box-shadow:0 4px 12px rgba(212,165,116,.2)}
    .login-card button:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(212,165,116,.3)}
    .login-card button:active{transform:translateY(0)}
    .login-err{color:#ef4444;font-size:13px;min-height:18px;margin-top:12px}

    /* ── App ── */
    #app{display:none;flex-direction:column;height:100dvh}

    /* ── Header ── */
    header{padding:10px 16px;background:rgba(15,15,26,.85);border-bottom:1px solid #1a1a2e;
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
      -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);z-index:10}
    header h1{font-size:15px;font-weight:600;
      background:linear-gradient(135deg,#d4a574,#e8c9a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .hdr-actions{display:flex;gap:5px}
    .hdr-btn{padding:6px 10px;border-radius:8px;border:1px solid #1a1a2e;
      background:rgba(18,18,31,.8);color:#52525b;cursor:pointer;font-size:11px;font-family:inherit;
      font-weight:500;transition:all .15s;display:flex;align-items:center;gap:4px}
    .hdr-btn:hover{background:#1a1a2e;color:#a1a1aa;border-color:#2a2a40}
    .hdr-btn svg{width:13px;height:13px}

    /* ── Stats bar ── */
    #stats-bar{padding:5px 16px;background:#08080f;border-bottom:1px solid #111120;
      font-size:11px;color:#2e2e45;display:flex;gap:14px;flex-shrink:0;
      font-variant-numeric:tabular-nums;overflow-x:auto}
    #stats-bar span{white-space:nowrap}
    #stats-bar .v{color:#3f3f5c;font-weight:500}

    /* ── Messages ── */
    #messages{flex:1;overflow-y:auto;padding:16px;position:relative;
      display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}
    #messages::-webkit-scrollbar{width:4px}
    #messages::-webkit-scrollbar-thumb{background:#1a1a2e;border-radius:2px}

    /* Empty state */
    .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;
      flex:1;color:#1e1e35;gap:12px;padding:40px;text-align:center;min-height:200px}
    .empty-state svg{width:48px;height:48px;opacity:.3}
    .empty-state p{font-size:14px;color:#2a2a40}
    .empty-state small{font-size:12px;color:#1e1e35}

    /* Message groups */
    .mg{display:flex;flex-direction:column;gap:2px;max-width:min(85%,760px);
      animation:fadeIn .25s ease}
    .mg.user{align-self:flex-end;align-items:flex-end}
    .mg.assistant{align-self:flex-start;align-items:flex-start}
    .mg.system{align-self:center}
    .mg.error{align-self:center}
    @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

    /* Bubbles */
    .bb{padding:10px 14px;border-radius:16px;line-height:1.6;font-size:14.5px;
      word-wrap:break-word;overflow-wrap:break-word}
    .user .bb{background:linear-gradient(135deg,#162544,#1a2a4a);color:#c8d6e8;
      border-bottom-right-radius:6px;white-space:pre-wrap}
    .assistant .bb{background:#111119;border:1px solid #1a1a28;border-bottom-left-radius:6px}
    .error .bb{background:#1a0a0a;border:1px solid #2a1515;color:#f87171;
      text-align:center;font-size:13px;border-radius:12px}
    .system .bb{background:none;color:#2e2e45;font-size:12px;padding:6px 0}

    /* Meta line (stats + source + time) */
    .meta{font-size:10px;color:#252540;padding:2px 4px;display:flex;gap:8px;
      font-variant-numeric:tabular-nums;flex-wrap:wrap;align-items:center}
    .meta .src-wa{color:#25D366}
    .meta .src-web{color:#3f3f5c}

    /* ── Markdown ── */
    .bb p{margin:.35em 0}.bb p:first-child{margin-top:0}.bb p:last-child{margin-bottom:0}
    .bb code{background:rgba(0,0,0,.45);padding:1px 5px;border-radius:4px;
      font-family:'JetBrains Mono',monospace;font-size:.84em}
    .bb pre{background:#08080f;padding:0;border-radius:10px;overflow:hidden;margin:8px 0;
      border:1px solid #151525;position:relative}
    .bb pre code{background:none;padding:14px;font-size:.82em;line-height:1.55;display:block;
      overflow-x:auto}
    .bb pre .copy-btn{position:absolute;top:6px;right:6px;padding:4px 8px;border-radius:6px;
      border:1px solid #1e1e35;background:rgba(11,11,20,.9);color:#52525b;cursor:pointer;
      font-size:10px;font-family:inherit;opacity:0;transition:opacity .2s}
    .bb pre:hover .copy-btn{opacity:1}
    .bb pre .copy-btn:hover{color:#d4a574;border-color:#d4a574}
    .bb ul,.bb ol{padding-left:18px;margin:.35em 0}
    .bb li{margin:.1em 0}
    .bb blockquote{border-left:3px solid #d4a574;padding-left:12px;margin:8px 0;color:#71717a}
    .bb a{color:#6ea8d4;text-decoration:none}.bb a:hover{text-decoration:underline}
    .bb table{border-collapse:collapse;margin:8px 0;font-size:.86em;display:block;overflow-x:auto}
    .bb th,.bb td{border:1px solid #1a1a2e;padding:5px 10px;text-align:left}
    .bb th{background:#0d0d18;font-weight:600}
    .bb strong{color:#e4e4e7}.bb em{color:#a1a1aa}
    .bb h1,.bb h2,.bb h3,.bb h4{color:#e4e4e7;margin:.5em 0 .25em;font-weight:600}
    .bb h1{font-size:1.15em}.bb h2{font-size:1.05em}.bb h3{font-size:1em}
    .bb hr{border:none;border-top:1px solid #1a1a2e;margin:10px 0}
    .bb img{max-width:100%;border-radius:8px;margin:8px 0}

    /* ── Cursor ── */
    .cur{display:inline-block;width:6px;height:15px;background:#d4a574;
      animation:bk .7s infinite;vertical-align:text-bottom;margin-left:2px;border-radius:1px}
    @keyframes bk{0%,40%{opacity:1}50%,100%{opacity:0}}

    /* ── Waiting ── */
    .wait{display:flex;align-items:center;gap:8px;color:#2e2e45;font-size:13px;padding:4px 0}
    .spin{width:14px;height:14px;border:2px solid #1a1a2e;border-top-color:#d4a574;
      border-radius:50%;animation:sp .6s linear infinite}
    @keyframes sp{to{transform:rotate(360deg)}}

    /* ── Scroll-to-bottom FAB ── */
    #scroll-fab{position:absolute;bottom:16px;right:16px;width:36px;height:36px;
      border-radius:50%;background:#1a1a2e;border:1px solid #252540;color:#71717a;
      cursor:pointer;display:none;align-items:center;justify-content:center;z-index:5;
      box-shadow:0 4px 12px rgba(0,0,0,.4);transition:all .2s}
    #scroll-fab:hover{background:#252540;color:#d4a574}
    #scroll-fab svg{width:16px;height:16px;fill:currentColor}

    /* ── Input ── */
    #input-area{padding:10px 12px max(10px,env(safe-area-inset-bottom));background:rgba(15,15,26,.9);
      border-top:1px solid #1a1a2e;display:flex;gap:8px;flex-shrink:0;align-items:flex-end;
      -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}
    #msg-input{flex:1;padding:10px 14px;border-radius:14px;
      border:1px solid #1e1e35;background:#0b0b14;color:#d4d4d8;
      font-size:15px;font-family:inherit;resize:none;
      outline:none;min-height:42px;max-height:160px;line-height:1.4;
      transition:all .2s}
    #msg-input:focus{border-color:#d4a574;box-shadow:0 0 0 3px rgba(212,165,116,.08)}
    #msg-input::placeholder{color:#2e2e45}
    #send-btn{width:42px;height:42px;border-radius:12px;border:none;
      background:linear-gradient(135deg,#d4a574,#c4915e);color:#0b0b14;
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      transition:all .2s;flex-shrink:0;box-shadow:0 2px 8px rgba(212,165,116,.15)}
    #send-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(212,165,116,.25)}
    #send-btn:active{transform:translateY(0)}
    #send-btn:disabled{opacity:.25;cursor:not-allowed;transform:none;box-shadow:none}
    #send-btn svg{width:17px;height:17px;fill:currentColor}

    /* ── QR Modal ── */
    #qr-modal{display:none;position:fixed;inset:0;z-index:100;
      background:rgba(0,0,0,.8);justify-content:center;align-items:center;
      -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
    #qr-modal.visible{display:flex}
    .qr-box{background:#12121f;border-radius:20px;padding:36px;
      text-align:center;border:1px solid #1e1e35;width:min(320px,85vw);
      box-shadow:0 20px 60px rgba(0,0,0,.5)}
    .qr-box h2{color:#d4a574;font-size:17px;font-weight:600;margin-bottom:20px}
    .qr-box img{border-radius:12px;width:200px;height:200px}
    .qr-box p{color:#2e2e45;font-size:11px;margin-top:14px;word-break:break-all}
    .qr-box .close-btn{margin-top:16px;padding:8px 24px;border-radius:10px;border:1px solid #1e1e35;
      background:transparent;color:#71717a;cursor:pointer;font-size:13px;font-family:inherit}
    .qr-box .close-btn:hover{background:#1a1a2e;color:#a1a1aa}

    /* ── Mobile ── */
    @media(max-width:640px){
      .mg{max-width:94%}
      #messages{padding:12px 8px}
      header{padding:8px 10px}
      .hdr-btn{padding:5px 7px;font-size:10px}
      .hdr-btn span{display:none}
      .login-card{padding:36px 24px;border-radius:16px}
      .bb{font-size:14px;padding:9px 12px;border-radius:14px}
      #stats-bar{padding:4px 10px;gap:8px;font-size:10px}
      .meta{font-size:9px}
    }
  </style>
</head>
<body>
  <div id="login">
    <div class="login-card">
      <h1>ARIA</h1>
      <p class="subtitle">Autonomous Reasoning & Insight Agent</p>
      <input type="password" id="pw-input" placeholder="Enter password" autofocus>
      <button onclick="doLogin()">Sign In</button>
      <div class="login-err" id="login-err"></div>
    </div>
  </div>

  <div id="app">
    <header>
      <h1>ARIA</h1>
      <div class="hdr-actions">
        <button class="hdr-btn" onclick="window.location='/aria'" title="Dashboard">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          <span>Status</span>
        </button>
        <button class="hdr-btn" onclick="showQr()" title="QR Code">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/><path d="M14 14h3v3"/></svg>
          <span>QR</span>
        </button>
        <button class="hdr-btn" onclick="doReset()" title="Reset conversation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
          <span>Reset</span>
        </button>
        <button class="hdr-btn" onclick="doLogout()" title="Sign out">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    </header>
    <div id="stats-bar">
      <span>Msgs <b class="v" id="st-m">0</b></span>
      <span>Tokens <b class="v" id="st-t">0</b></span>
      <span>Cost <b class="v" id="st-c">\$0.00</b></span>
    </div>
    <div id="messages" style="position:relative">
      <div class="empty-state" id="empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <p>Talk to ARIA</p>
        <small>Messages from web and WhatsApp appear here</small>
      </div>
    </div>
    <button id="scroll-fab" onclick="scrollBottom()">
      <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
    </button>
    <div id="qr-modal" onclick="hideQr()">
      <div class="qr-box" onclick="event.stopPropagation()">
        <h2>Open on mobile</h2>
        <img id="qr-img" alt="QR Code">
        <p id="qr-url"></p>
        <button class="close-btn" onclick="hideQr()">Close</button>
      </div>
    </div>
    <div id="input-area">
      <textarea id="msg-input" placeholder="Message ARIA..." rows="1"></textarea>
      <button id="send-btn" onclick="doSend()">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <script>
    let token = localStorage.getItem('agent_token');
    let busy = false, totTok = 0, totCost = 0, nMsg = 0;
    let renderTimer = null;

    marked.setOptions({ breaks: true, gfm: true, highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    }});

    const msgEl = document.getElementById('messages');
    const msgInput = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const fab = document.getElementById('scroll-fab');

    // Auto-resize + enter
    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
    });
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    document.getElementById('pw-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });

    // Scroll-to-bottom FAB
    msgEl.addEventListener('scroll', () => {
      const atBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 80;
      fab.style.display = atBottom ? 'none' : 'flex';
    });

    // Auth check
    if (token) {
      fetch('/api/auth-check', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(r => r.json()).then(d => d.authenticated ? showApp() : resetAuth()).catch(() => resetAuth());
    }

    function resetAuth() {
      localStorage.removeItem('agent_token'); token = null;
      document.getElementById('login').style.display = 'flex';
      document.getElementById('app').style.display = 'none';
    }
    function showApp() {
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      loadHistory();
      msgInput.focus();
    }
    function updateStats() {
      document.getElementById('st-m').textContent = nMsg;
      document.getElementById('st-t').textContent = totTok.toLocaleString();
      document.getElementById('st-c').textContent = '\$' + totCost.toFixed(4);
    }

    async function loadHistory() {
      try {
        const res = await fetch('/api/history', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!res.ok) return;
        const msgs = await res.json();
        if (!msgs.length) return;
        document.getElementById('empty')?.remove();
        totTok = 0; totCost = 0; nMsg = 0;
        for (const m of msgs) {
          const { group } = addGroup(m.role, m.content, false, m.timestamp, m.source);
          if (m.role === 'assistant' && m.stats) addMeta(group, m.stats, m.source, m.timestamp);
          else if (m.source) addMeta(group, null, m.source, m.timestamp);
        }
        addCopyBtns();
        scrollBottom();
        updateStats();
      } catch {}
    }

    async function doLogin() {
      const pw = document.getElementById('pw-input').value;
      const err = document.getElementById('login-err');
      err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }) });
        const d = await res.json();
        if (d.success) { token = d.token; localStorage.setItem('agent_token', token); showApp(); }
        else { err.textContent = d.error || 'Login failed'; }
      } catch { err.textContent = 'Connection error'; }
    }
    function doLogout() {
      localStorage.removeItem('agent_token'); token = null;
      msgEl.innerHTML = ''; totTok = 0; totCost = 0; nMsg = 0;
      resetAuth();
    }

    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (d.toDateString() === now.toDateString()) return time;
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
    }

    function addGroup(role, content, raw, ts, source) {
      document.getElementById('empty')?.remove();
      const g = document.createElement('div');
      g.className = 'mg ' + role;
      const b = document.createElement('div');
      b.className = 'bb';
      if (raw) b.innerHTML = content;
      else if (role === 'assistant' || role === 'system') b.innerHTML = marked.parse(content);
      else b.textContent = content;
      g.appendChild(b);
      msgEl.appendChild(g);
      scrollBottom();
      return { group: g, bubble: b };
    }

    function addMeta(group, stats, source, ts) {
      const m = document.createElement('div');
      m.className = 'meta';
      let h = '';
      if (stats) {
        const dur = stats.durationMs >= 1000 ? (stats.durationMs/1000).toFixed(1)+'s' : stats.durationMs+'ms';
        h += '<span>'+dur+'</span>';
        h += '<span>'+(stats.inputTokens+stats.outputTokens).toLocaleString()+' tok</span>';
        h += '<span>\$'+stats.totalCostUsd.toFixed(4)+'</span>';
        if (stats.numTurns > 1) h += '<span>'+stats.numTurns+' turns</span>';
        totTok += (stats.inputTokens||0) + (stats.outputTokens||0);
        totCost += stats.totalCostUsd || 0;
        nMsg++;
        updateStats();
      }
      if (source === 'whatsapp') h += '<span class="src-wa">WhatsApp</span>';
      if (ts) h += '<span>'+fmtTime(ts)+'</span>';
      m.innerHTML = h;
      group.appendChild(m);
    }

    function addCopyBtns() {
      msgEl.querySelectorAll('pre:not([data-copy])').forEach(pre => {
        pre.setAttribute('data-copy', '1');
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.onclick = () => {
          navigator.clipboard.writeText(pre.querySelector('code')?.textContent || '');
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy', 1500);
        };
        pre.style.position = 'relative';
        pre.appendChild(btn);
      });
    }

    function scrollBottom() {
      requestAnimationFrame(() => { msgEl.scrollTop = msgEl.scrollHeight; });
      fab.style.display = 'none';
    }

    async function doSend() {
      if (busy) return;
      const text = msgInput.value.trim();
      if (!text) return;
      msgInput.value = ''; msgInput.style.height = 'auto';
      busy = true; sendBtn.disabled = true;

      addGroup('user', text, false, Date.now(), 'web');
      const { group: ag, bubble: ab } = addGroup('assistant', '<span class="cur"></span>', true);
      let full = '', lastStats = null;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: text }) });
        if (res.status === 401) { ag.remove(); addGroup('error','Session expired'); doLogout(); return; }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'delta') {
                full += ev.text;
                // Throttle markdown renders to every 80ms
                if (!renderTimer) {
                  renderTimer = setTimeout(() => {
                    ab.innerHTML = marked.parse(full) + '<span class="cur"></span>';
                    scrollBottom();
                    renderTimer = null;
                  }, 80);
                }
              } else if (ev.type === 'queued') {
                ab.innerHTML = '<div class="wait"><div class="spin"></div>Waiting in queue...</div>';
              } else if (ev.type === 'start') {
                ab.innerHTML = '<span class="cur"></span>';
              } else if (ev.type === 'done') {
                if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
                ab.innerHTML = full ? marked.parse(full) : '<em style="color:#2e2e45">No response</em>';
                lastStats = ev.stats || null;
                addCopyBtns();
              } else if (ev.type === 'error') {
                ag.remove(); addGroup('error', ev.error);
              }
            } catch {}
          }
        }
        if (full && ab.querySelector('.cur')) {
          ab.innerHTML = marked.parse(full);
          addCopyBtns();
        }
        if (lastStats) addMeta(ag, lastStats, 'web', Date.now());
      } catch (err) {
        ag.remove(); addGroup('error', 'Connection error: ' + err.message);
      } finally {
        busy = false; sendBtn.disabled = false; msgInput.focus();
      }
    }

    function showQr() {
      const url = window.location.href;
      document.getElementById('qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=d4a574&bgcolor=12121f&data=' + encodeURIComponent(url);
      document.getElementById('qr-url').textContent = url;
      document.getElementById('qr-modal').classList.add('visible');
    }
    function hideQr() { document.getElementById('qr-modal').classList.remove('visible'); }

    async function doReset() {
      if (busy) return;
      busy = true; sendBtn.disabled = true;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: '/reset' }) });
        const reader = res.body.getReader();
        while (true) { const { done } = await reader.read(); if (done) break; }
        msgEl.innerHTML = '';
        totTok = 0; totCost = 0; nMsg = 0; updateStats();
        addGroup('system', 'Session reset. Starting fresh.');
      } catch { addGroup('error', 'Failed to reset'); }
      finally { busy = false; sendBtn.disabled = false; }
    }
  </script>
</body>
</html>`;
}
