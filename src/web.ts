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
          res.write(`data: ${JSON.stringify({ type: "done", sessionId: result.sessionId })}\n\n`);
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Agent</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f17; color: #e0e0e0; height: 100dvh;
      display: flex; flex-direction: column;
    }

    /* Login */
    #login {
      display: flex; justify-content: center; align-items: center;
      height: 100dvh; flex-direction: column; gap: 16px;
    }
    #login h1 { color: #d4a574; font-size: 28px; font-weight: 700; }
    #login p { color: #666; font-size: 14px; margin-bottom: 8px; }
    #login input {
      padding: 12px 16px; border-radius: 10px; border: 1px solid #2a2a3e;
      background: #1a1a2e; color: #e0e0e0; font-size: 16px; width: 300px;
      outline: none; transition: border-color 0.2s;
    }
    #login input:focus { border-color: #d4a574; }
    #login button {
      padding: 12px 32px; border-radius: 10px; border: none;
      background: #d4a574; color: #0f0f17; font-size: 16px;
      cursor: pointer; font-weight: 600; transition: background 0.2s;
    }
    #login button:hover { background: #e0b88a; }
    .login-error { color: #ff6b6b; font-size: 14px; min-height: 20px; }

    /* App */
    #app { display: none; flex-direction: column; height: 100dvh; }

    /* Header */
    #header {
      padding: 14px 20px; background: #1a1a2e;
      border-bottom: 1px solid #252540; display: flex;
      align-items: center; justify-content: space-between; flex-shrink: 0;
    }
    #header h1 { font-size: 17px; color: #d4a574; font-weight: 600; }
    #header .actions { display: flex; gap: 8px; }
    .hdr-btn {
      padding: 6px 14px; border-radius: 8px; border: 1px solid #333;
      background: transparent; color: #999; cursor: pointer; font-size: 13px;
      transition: all 0.15s;
    }
    .hdr-btn:hover { background: #252540; color: #e0e0e0; border-color: #444; }

    /* Messages */
    #messages {
      flex: 1; overflow-y: auto; padding: 20px 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; line-height: 1.55; font-size: 15px; }
    .msg.user {
      align-self: flex-end; background: #1e3a5f; border-bottom-right-radius: 4px;
      white-space: pre-wrap;
    }
    .msg.assistant {
      align-self: flex-start; background: #1e2240; border-bottom-left-radius: 4px;
    }
    .msg.error {
      align-self: center; background: #3a1a1a; color: #ff8888;
      font-size: 14px; text-align: center; border-radius: 10px;
    }
    .msg.system {
      align-self: center; color: #555; font-size: 13px; text-align: center;
      padding: 4px; background: none;
    }

    /* Markdown in messages */
    .msg p { margin: 0.4em 0; }
    .msg p:first-child { margin-top: 0; }
    .msg p:last-child { margin-bottom: 0; }
    .msg code {
      background: rgba(0,0,0,0.35); padding: 1.5px 5px; border-radius: 4px;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 0.88em;
    }
    .msg pre {
      background: rgba(0,0,0,0.4); padding: 12px; border-radius: 8px;
      overflow-x: auto; margin: 8px 0;
    }
    .msg pre code { background: none; padding: 0; font-size: 0.84em; }
    .msg ul, .msg ol { padding-left: 20px; margin: 0.4em 0; }
    .msg li { margin: 0.2em 0; }
    .msg blockquote {
      border-left: 3px solid #d4a574; padding-left: 12px;
      margin: 8px 0; color: #999;
    }
    .msg a { color: #7eb8da; text-decoration: none; }
    .msg a:hover { text-decoration: underline; }
    .msg table { border-collapse: collapse; margin: 8px 0; font-size: 0.9em; }
    .msg th, .msg td { border: 1px solid #333; padding: 6px 10px; }
    .msg th { background: rgba(0,0,0,0.3); }

    /* Cursor */
    .cursor {
      display: inline-block; width: 7px; height: 15px;
      background: #d4a574; animation: blink 0.8s infinite;
      vertical-align: text-bottom; margin-left: 2px; border-radius: 1px;
    }
    @keyframes blink { 0%,45% { opacity: 1; } 55%,100% { opacity: 0; } }

    /* Queue indicator */
    .queued-indicator {
      display: flex; align-items: center; gap: 8px; justify-content: center;
      color: #666; font-size: 13px; padding: 8px;
    }
    .spinner {
      width: 14px; height: 14px; border: 2px solid #333;
      border-top-color: #d4a574; border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Input */
    #input-area {
      padding: 14px 16px; background: #1a1a2e;
      border-top: 1px solid #252540; display: flex; gap: 10px;
      flex-shrink: 0;
    }
    #msg-input {
      flex: 1; padding: 10px 14px; border-radius: 12px;
      border: 1px solid #2a2a3e; background: #0d0d1a; color: #e0e0e0;
      font-size: 15px; font-family: inherit; resize: none;
      outline: none; min-height: 42px; max-height: 140px;
      transition: border-color 0.2s;
    }
    #msg-input:focus { border-color: #d4a574; }
    #send-btn {
      padding: 0 20px; border-radius: 12px; border: none;
      background: #d4a574; color: #0f0f17; font-size: 15px;
      cursor: pointer; font-weight: 600; transition: all 0.15s;
      white-space: nowrap; align-self: flex-end; height: 42px;
    }
    #send-btn:hover { background: #e0b88a; }
    #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #2a2a3e; border-radius: 3px; }

    /* QR modal */
    #qr-modal {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.7); justify-content: center; align-items: center;
    }
    #qr-modal.visible { display: flex; }
    .qr-box {
      background: #1a1a2e; border-radius: 16px; padding: 28px;
      text-align: center; border: 1px solid #252540;
    }
    .qr-box h2 { color: #d4a574; font-size: 18px; margin-bottom: 16px; }
    .qr-box img { border-radius: 8px; width: 220px; height: 220px; }
    .qr-box p { color: #666; font-size: 12px; margin-top: 12px; word-break: break-all; max-width: 260px; }

    @media (max-width: 600px) {
      .msg { max-width: 92%; }
      #messages { padding: 14px 10px; }
    }
  </style>
</head>
<body>
  <div id="login">
    <h1>Claude Agent</h1>
    <p>Personal AI assistant</p>
    <input type="password" id="pw-input" placeholder="Password" autofocus>
    <button onclick="doLogin()">Sign In</button>
    <div class="login-error" id="login-err"></div>
  </div>

  <div id="app">
    <div id="header">
      <h1>Claude Agent</h1>
      <div class="actions">
        <button class="hdr-btn" onclick="showQr()">QR</button>
        <button class="hdr-btn" onclick="doReset()">Reset</button>
        <button class="hdr-btn" onclick="doLogout()">Logout</button>
      </div>
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
      <button id="send-btn" onclick="doSend()">Send</button>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    let token = localStorage.getItem('agent_token');
    let busy = false;

    marked.setOptions({ breaks: true, gfm: true });

    // Auto-resize textarea
    const msgInput = document.getElementById('msg-input');
    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + 'px';
    });
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    document.getElementById('pw-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });

    // Check existing session
    if (token) {
      fetch('/api/auth-check', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(r => r.json())
        .then(d => d.authenticated ? showApp() : resetAuth())
        .catch(() => resetAuth());
    }

    function resetAuth() {
      localStorage.removeItem('agent_token');
      token = null;
      document.getElementById('login').style.display = 'flex';
      document.getElementById('app').style.display = 'none';
    }

    function showApp() {
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      msgInput.focus();
    }

    async function doLogin() {
      const pw = document.getElementById('pw-input').value;
      const err = document.getElementById('login-err');
      err.textContent = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        const d = await res.json();
        if (d.success) {
          token = d.token;
          localStorage.setItem('agent_token', token);
          showApp();
        } else {
          err.textContent = d.error || 'Login failed';
        }
      } catch { err.textContent = 'Connection error'; }
    }

    function doLogout() {
      localStorage.removeItem('agent_token');
      token = null;
      document.getElementById('messages').innerHTML = '';
      resetAuth();
    }

    function addMsg(role, content, raw) {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      if (raw) {
        el.innerHTML = content;
      } else if (role === 'assistant') {
        el.innerHTML = marked.parse(content);
      } else {
        el.textContent = content;
      }
      document.getElementById('messages').appendChild(el);
      scrollBottom();
      return el;
    }

    function scrollBottom() {
      const m = document.getElementById('messages');
      m.scrollTop = m.scrollHeight;
    }

    async function doSend() {
      if (busy) return;
      const text = msgInput.value.trim();
      if (!text) return;

      msgInput.value = '';
      msgInput.style.height = 'auto';
      busy = true;
      document.getElementById('send-btn').disabled = true;

      addMsg('user', text);
      const assistantEl = addMsg('assistant', '<span class="cursor"></span>', true);
      let fullText = '';

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: text }),
        });

        if (res.status === 401) {
          assistantEl.remove();
          addMsg('error', 'Session expired. Please log in again.');
          doLogout();
          return;
        }

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
                assistantEl.innerHTML = marked.parse(fullText) + '<span class="cursor"></span>';
                scrollBottom();
              } else if (ev.type === 'queued') {
                assistantEl.innerHTML = '<div class="queued-indicator"><div class="spinner"></div>Waiting in queue...</div>';
              } else if (ev.type === 'start') {
                assistantEl.innerHTML = '<span class="cursor"></span>';
              } else if (ev.type === 'done') {
                assistantEl.innerHTML = fullText ? marked.parse(fullText) : '<em style="color:#666">No response</em>';
              } else if (ev.type === 'error') {
                assistantEl.remove();
                addMsg('error', ev.error);
              }
            } catch {}
          }
        }

        if (fullText && !assistantEl.querySelector('.cursor')) {
          // Already rendered by 'done' event
        } else if (fullText) {
          assistantEl.innerHTML = marked.parse(fullText);
        }
      } catch (err) {
        assistantEl.remove();
        addMsg('error', 'Connection error: ' + err.message);
      } finally {
        busy = false;
        document.getElementById('send-btn').disabled = false;
        msgInput.focus();
      }
    }

    function showQr() {
      const url = window.location.href;
      document.getElementById('qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(url);
      document.getElementById('qr-url').textContent = url;
      document.getElementById('qr-modal').classList.add('visible');
    }
    function hideQr() {
      document.getElementById('qr-modal').classList.remove('visible');
    }

    async function doReset() {
      if (busy) return;
      busy = true;
      document.getElementById('send-btn').disabled = true;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ message: '/reset' }),
        });
        const reader = res.body.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        addMsg('system', 'Session reset');
      } catch {
        addMsg('error', 'Failed to reset session');
      } finally {
        busy = false;
        document.getElementById('send-btn').disabled = false;
      }
    }
  </script>
</body>
</html>`;
}
