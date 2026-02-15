import { randomBytes } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { appendFileSync } from "fs";
import { askClaudeStreaming, resetSession } from "./claude.js";
import { MessageQueue } from "./queue.js";
import { getHistory, addMessage, clearHistory } from "./history.js";

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

function getChatHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#0b0b14">
  <title>Claude Agent</title>
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
      <h1>Claude Agent</h1>
      <p class="subtitle">Personal AI Assistant</p>
      <input type="password" id="pw-input" placeholder="Enter password" autofocus>
      <button onclick="doLogin()">Sign In</button>
      <div class="login-err" id="login-err"></div>
    </div>
  </div>

  <div id="app">
    <header>
      <h1>Claude Agent</h1>
      <div class="hdr-actions">
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
        <p>Start a conversation</p>
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
      <textarea id="msg-input" placeholder="Message Claude..." rows="1"></textarea>
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
