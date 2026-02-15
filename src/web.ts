import { randomBytes } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { appendFileSync } from "fs";
import { askClaudeStreaming, resetSession } from "./claude.js";
import { MessageQueue } from "./queue.js";

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
          res.write(`data: ${JSON.stringify({ type: "delta", text: "Session reset. Starting fresh conversation." })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          return;
        }

        res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);

        const result = await askClaudeStreaming(message, (delta) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`);
          }
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
  <title>Claude Agent</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html{height:100%;-webkit-text-size-adjust:100%}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#0b0b14;color:#d4d4d8;
      height:100dvh;display:flex;flex-direction:column;overflow:hidden}

    /* ── Login ── */
    #login{display:flex;justify-content:center;align-items:center;height:100dvh;
      flex-direction:column;gap:20px;background:radial-gradient(ellipse at 50% 0%,#1a1a30 0%,#0b0b14 70%)}
    .login-card{background:#12121f;border:1px solid #1e1e35;border-radius:16px;padding:40px 36px;
      width:min(360px,90vw);text-align:center}
    .login-card h1{font-size:26px;font-weight:700;
      background:linear-gradient(135deg,#d4a574,#e8c9a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    .login-card p{color:#52525b;font-size:13px;margin:8px 0 24px;letter-spacing:0.3px}
    .login-card input{width:100%;padding:12px 16px;border-radius:10px;border:1px solid #1e1e35;
      background:#0b0b14;color:#d4d4d8;font-size:15px;font-family:inherit;outline:none;
      transition:border-color .2s}
    .login-card input:focus{border-color:#d4a574}
    .login-card button{width:100%;padding:13px;border-radius:10px;border:none;margin-top:14px;
      background:linear-gradient(135deg,#d4a574,#c4915e);color:#0b0b14;font-size:15px;
      font-weight:600;cursor:pointer;font-family:inherit;transition:opacity .15s}
    .login-card button:hover{opacity:.9}
    .login-err{color:#ef4444;font-size:13px;min-height:18px;margin-top:10px}

    /* ── App shell ── */
    #app{display:none;flex-direction:column;height:100dvh}

    /* ── Header ── */
    header{padding:12px 16px;background:#0f0f1a;border-bottom:1px solid #1a1a2e;
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
      gap:12px;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);z-index:10}
    header h1{font-size:16px;font-weight:600;
      background:linear-gradient(135deg,#d4a574,#e8c9a0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;
      white-space:nowrap}
    .hdr-actions{display:flex;gap:6px;flex-shrink:0}
    .hdr-btn{padding:6px 12px;border-radius:8px;border:1px solid #1e1e35;
      background:#12121f;color:#71717a;cursor:pointer;font-size:12px;font-family:inherit;
      font-weight:500;transition:all .15s}
    .hdr-btn:hover{background:#1a1a2e;color:#a1a1aa;border-color:#2a2a40}
    .hdr-btn svg{width:14px;height:14px;vertical-align:-2px;stroke:currentColor;fill:none;stroke-width:2}

    /* ── Session stats bar ── */
    #session-stats{padding:4px 16px;background:#0a0a12;border-bottom:1px solid #141425;
      font-size:11px;color:#3f3f5c;display:flex;gap:16px;flex-shrink:0;
      font-variant-numeric:tabular-nums}
    #session-stats span{display:inline-flex;align-items:center;gap:4px}
    #session-stats .val{color:#52525b}

    /* ── Messages ── */
    #messages{flex:1;overflow-y:auto;padding:20px 16px;
      display:flex;flex-direction:column;gap:4px;
      scroll-behavior:smooth;overscroll-behavior:contain}
    #messages::-webkit-scrollbar{width:4px}
    #messages::-webkit-scrollbar-track{background:transparent}
    #messages::-webkit-scrollbar-thumb{background:#1e1e35;border-radius:2px}

    /* Message groups */
    .msg-group{display:flex;flex-direction:column;gap:2px;max-width:min(85%,720px)}
    .msg-group.user{align-self:flex-end;align-items:flex-end}
    .msg-group.assistant{align-self:flex-start;align-items:flex-start}
    .msg-group.system{align-self:center}

    /* Message bubbles */
    .bubble{padding:10px 14px;border-radius:16px;line-height:1.6;font-size:14.5px;
      word-wrap:break-word;overflow-wrap:break-word}
    .user .bubble{background:#1a2a4a;color:#c8d6e8;border-bottom-right-radius:6px;white-space:pre-wrap}
    .assistant .bubble{background:#14141f;border:1px solid #1a1a2e;border-bottom-left-radius:6px}
    .error .bubble{background:#1f1010;border:1px solid #2a1515;color:#f87171;text-align:center;font-size:13px}
    .system .bubble{background:none;color:#3f3f5c;font-size:12px;padding:8px 0}

    /* Stats line below assistant message */
    .msg-stats{font-size:11px;color:#2e2e45;padding:2px 4px;display:flex;gap:10px;
      font-variant-numeric:tabular-nums}
    .msg-stats span{display:inline-flex;align-items:center;gap:3px}

    /* ── Markdown ── */
    .bubble p{margin:.4em 0}.bubble p:first-child{margin-top:0}.bubble p:last-child{margin-bottom:0}
    .bubble code{background:rgba(0,0,0,.4);padding:1px 5px;border-radius:4px;
      font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:.86em}
    .bubble pre{background:#0a0a12;padding:12px;border-radius:10px;overflow-x:auto;margin:8px 0;
      border:1px solid #1a1a2e}
    .bubble pre code{background:none;padding:0;font-size:.83em;line-height:1.5}
    .bubble ul,.bubble ol{padding-left:18px;margin:.4em 0}
    .bubble li{margin:.15em 0}
    .bubble blockquote{border-left:3px solid #d4a574;padding-left:12px;margin:8px 0;color:#71717a}
    .bubble a{color:#6ea8d4;text-decoration:none}.bubble a:hover{text-decoration:underline}
    .bubble table{border-collapse:collapse;margin:8px 0;font-size:.88em;width:100%;overflow-x:auto;display:block}
    .bubble th,.bubble td{border:1px solid #1e1e35;padding:6px 10px;text-align:left}
    .bubble th{background:#0f0f1a}
    .bubble strong{color:#e4e4e7}
    .bubble h1,.bubble h2,.bubble h3,.bubble h4{color:#e4e4e7;margin:.6em 0 .3em;font-weight:600}
    .bubble h1{font-size:1.2em}.bubble h2{font-size:1.1em}.bubble h3{font-size:1em}
    .bubble hr{border:none;border-top:1px solid #1e1e35;margin:12px 0}

    /* ── Cursor ── */
    .cursor{display:inline-block;width:6px;height:14px;background:#d4a574;
      animation:blink .7s infinite;vertical-align:text-bottom;margin-left:2px;border-radius:1px}
    @keyframes blink{0%,40%{opacity:1}50%,100%{opacity:0}}

    /* ── Queue/spinner ── */
    .wait{display:flex;align-items:center;gap:8px;color:#3f3f5c;font-size:13px;padding:4px 0}
    .spin{width:14px;height:14px;border:2px solid #1e1e35;border-top-color:#d4a574;
      border-radius:50%;animation:sp .6s linear infinite}
    @keyframes sp{to{transform:rotate(360deg)}}

    /* ── Input ── */
    #input-area{padding:12px 12px max(12px,env(safe-area-inset-bottom));background:#0f0f1a;
      border-top:1px solid #1a1a2e;display:flex;gap:8px;flex-shrink:0;align-items:flex-end}
    #msg-input{flex:1;padding:10px 14px;border-radius:14px;
      border:1px solid #1e1e35;background:#0b0b14;color:#d4d4d8;
      font-size:15px;font-family:inherit;resize:none;
      outline:none;min-height:42px;max-height:160px;line-height:1.4;
      transition:border-color .2s}
    #msg-input:focus{border-color:#d4a574}
    #msg-input::placeholder{color:#3f3f5c}
    #send-btn{width:42px;height:42px;border-radius:12px;border:none;
      background:linear-gradient(135deg,#d4a574,#c4915e);color:#0b0b14;
      cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;
      transition:opacity .15s;flex-shrink:0}
    #send-btn:hover{opacity:.85}
    #send-btn:disabled{opacity:.3;cursor:not-allowed}
    #send-btn svg{width:18px;height:18px;fill:currentColor}

    /* ── QR Modal ── */
    #qr-modal{display:none;position:fixed;inset:0;z-index:100;
      background:rgba(0,0,0,.75);justify-content:center;align-items:center;
      -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
    #qr-modal.visible{display:flex}
    .qr-box{background:#12121f;border-radius:16px;padding:32px;
      text-align:center;border:1px solid #1e1e35;width:min(320px,85vw)}
    .qr-box h2{color:#d4a574;font-size:17px;font-weight:600;margin-bottom:20px}
    .qr-box img{border-radius:10px;width:200px;height:200px}
    .qr-box p{color:#3f3f5c;font-size:11px;margin-top:14px;word-break:break-all}

    /* ── Mobile ── */
    @media(max-width:640px){
      .msg-group{max-width:92%}
      #messages{padding:14px 10px}
      header{padding:10px 12px}
      .hdr-btn{padding:5px 8px;font-size:11px}
      .login-card{padding:32px 24px}
      .bubble{font-size:14px}
      #session-stats{padding:3px 12px;gap:10px;font-size:10px;flex-wrap:wrap}
    }
  </style>
</head>
<body>
  <div id="login">
    <div class="login-card">
      <h1>Claude Agent</h1>
      <p>Personal AI assistant</p>
      <input type="password" id="pw-input" placeholder="Password" autofocus>
      <button onclick="doLogin()">Sign In</button>
      <div class="login-err" id="login-err"></div>
    </div>
  </div>

  <div id="app">
    <header>
      <h1>Claude Agent</h1>
      <div class="hdr-actions">
        <button class="hdr-btn" onclick="showQr()" title="QR Code"><svg viewBox="0 0 24 24"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM17 14h3v3h-3zM14 17h3v3h-3zM17 20h3v3h-3z"/></svg></button>
        <button class="hdr-btn" onclick="doReset()">Reset</button>
        <button class="hdr-btn" onclick="doLogout()">Logout</button>
      </div>
    </header>
    <div id="session-stats">
      <span>Messages: <b class="val" id="st-msgs">0</b></span>
      <span>Tokens: <b class="val" id="st-tokens">0</b></span>
      <span>Cost: <b class="val" id="st-cost">\$0.00</b></span>
      <span>Session: <b class="val" id="st-time">0s</b></span>
    </div>
    <div id="messages"></div>
    <div id="qr-modal" onclick="hideQr()">
      <div class="qr-box" onclick="event.stopPropagation()">
        <h2>Open on mobile</h2>
        <img id="qr-img" alt="QR Code">
        <p id="qr-url"></p>
      </div>
    </div>
    <div id="input-area">
      <textarea id="msg-input" placeholder="Send a message..." rows="1"></textarea>
      <button id="send-btn" onclick="doSend()">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    let token = localStorage.getItem('agent_token');
    let busy = false;
    let totalTokens = 0, totalCost = 0, msgCount = 0, sessionStart = Date.now();

    marked.setOptions({ breaks: true, gfm: true });

    const msgInput = document.getElementById('msg-input');
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
      sessionStart = Date.now(); updateSessionStats();
      msgInput.focus();
    }

    function updateSessionStats() {
      document.getElementById('st-msgs').textContent = msgCount;
      document.getElementById('st-tokens').textContent = totalTokens.toLocaleString();
      document.getElementById('st-cost').textContent = '\$' + totalCost.toFixed(4);
      const secs = Math.floor((Date.now() - sessionStart) / 1000);
      const m = Math.floor(secs / 60), s = secs % 60;
      document.getElementById('st-time').textContent = m > 0 ? m + 'm ' + s + 's' : s + 's';
    }
    setInterval(updateSessionStats, 5000);

    async function doLogin() {
      const pw = document.getElementById('pw-input').value;
      const err = document.getElementById('login-err');
      err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        const d = await res.json();
        if (d.success) { token = d.token; localStorage.setItem('agent_token', token); showApp(); }
        else { err.textContent = d.error || 'Login failed'; }
      } catch { err.textContent = 'Connection error'; }
    }
    function doLogout() {
      localStorage.removeItem('agent_token'); token = null;
      document.getElementById('messages').innerHTML = '';
      totalTokens = 0; totalCost = 0; msgCount = 0;
      resetAuth();
    }

    function addGroup(role, content, raw) {
      const g = document.createElement('div');
      g.className = 'msg-group ' + role;
      const b = document.createElement('div');
      b.className = 'bubble';
      if (raw) b.innerHTML = content;
      else if (role === 'assistant') b.innerHTML = marked.parse(content);
      else b.textContent = content;
      g.appendChild(b);
      document.getElementById('messages').appendChild(g);
      scrollBottom();
      return { group: g, bubble: b };
    }
    function addStats(group, stats) {
      if (!stats) return;
      const s = document.createElement('div');
      s.className = 'msg-stats';
      const dur = stats.durationMs >= 1000 ? (stats.durationMs/1000).toFixed(1)+'s' : stats.durationMs+'ms';
      const tok = (stats.inputTokens + stats.outputTokens).toLocaleString();
      const cost = '\$' + stats.totalCostUsd.toFixed(4);
      s.innerHTML = '<span>'+dur+'</span><span>'+tok+' tokens</span><span>'+cost+'</span>';
      if (stats.numTurns > 1) s.innerHTML += '<span>'+stats.numTurns+' turns</span>';
      group.appendChild(s);

      totalTokens += stats.inputTokens + stats.outputTokens;
      totalCost += stats.totalCostUsd;
      msgCount++;
      updateSessionStats();
    }

    function scrollBottom() {
      const m = document.getElementById('messages');
      m.scrollTop = m.scrollHeight;
    }

    async function doSend() {
      if (busy) return;
      const text = msgInput.value.trim();
      if (!text) return;
      msgInput.value = ''; msgInput.style.height = 'auto';
      busy = true; document.getElementById('send-btn').disabled = true;

      addGroup('user', text);
      const { group: aGroup, bubble: aBubble } = addGroup('assistant', '<span class="cursor"></span>', true);
      let fullText = '', lastStats = null;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: text }),
        });
        if (res.status === 401) { aGroup.remove(); addGroup('error', 'Session expired'); doLogout(); return; }

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
                fullText += ev.text;
                aBubble.innerHTML = marked.parse(fullText) + '<span class="cursor"></span>';
                scrollBottom();
              } else if (ev.type === 'queued') {
                aBubble.innerHTML = '<div class="wait"><div class="spin"></div>Waiting in queue...</div>';
              } else if (ev.type === 'start') {
                aBubble.innerHTML = '<span class="cursor"></span>';
              } else if (ev.type === 'done') {
                aBubble.innerHTML = fullText ? marked.parse(fullText) : '<em style="color:#3f3f5c">No response</em>';
                lastStats = ev.stats || null;
              } else if (ev.type === 'error') {
                aGroup.remove(); addGroup('error', ev.error);
              }
            } catch {}
          }
        }
        if (fullText && aBubble.querySelector('.cursor')) aBubble.innerHTML = marked.parse(fullText);
        if (lastStats) addStats(aGroup, lastStats);
      } catch (err) {
        aGroup.remove(); addGroup('error', 'Connection error: ' + err.message);
      } finally {
        busy = false; document.getElementById('send-btn').disabled = false; msgInput.focus();
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
      busy = true; document.getElementById('send-btn').disabled = true;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: '/reset' }),
        });
        const reader = res.body.getReader();
        while (true) { const { done } = await reader.read(); if (done) break; }
        addGroup('system', 'Session reset');
        totalTokens = 0; totalCost = 0; msgCount = 0; sessionStart = Date.now(); updateSessionStats();
      } catch { addGroup('error', 'Failed to reset session'); }
      finally { busy = false; document.getElementById('send-btn').disabled = false; }
    }
  </script>
</body>
</html>`;
}
