import { getStyles } from "./styles.js";

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>` },
  { id: "chat", label: "Chat", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>` },
  { id: "memory", label: "Memory", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>` },
  { id: "requests", label: "Requests", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>` },
  { id: "integrations", label: "Integrations", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>` },
  { id: "ai-providers", label: "AI Providers", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 014 4v1a1 1 0 001 1h1a4 4 0 010 8h-1a1 1 0 00-1 1v1a4 4 0 01-8 0v-1a1 1 0 00-1-1H6a4 4 0 010-8h1a1 1 0 001-1V6a4 4 0 014-4z"/><circle cx="12" cy="12" r="2"/></svg>` },
  { id: "settings", label: "Settings", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>` },
];

export function getDashboardHTML(): string {
  const navItemsHTML = NAV_ITEMS.map(n =>
    `<div class="nav-item" data-section="${n.id}" onclick="navigate('${n.id}')">${n.icon}<span>${n.label}</span></div>`
  ).join("");

  const mobileNavHTML = NAV_ITEMS.map(n =>
    `<button class="mob-nav-item" data-section="${n.id}" onclick="navigate('${n.id}')">${n.icon}<span>${n.label}</span></button>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#060610">
  <title>ARIA Mainframe</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark-dimmed.min.css">
  <style>${getStyles()}</style>
</head>
<body>
  <!-- Login Screen -->
  <div id="login">
    <div class="login-ring"></div>
    <div class="login-card">
      <h1>ARIA</h1>
      <p class="subtitle">Mainframe Access</p>
      <input type="password" id="pw-input" placeholder="Enter access code" autofocus>
      <button onclick="doLogin()">Initialize</button>
      <div class="login-err" id="login-err"></div>
    </div>
  </div>

  <!-- Main App -->
  <div id="app">
    <!-- Sidebar (desktop) -->
    <div class="sidebar">
      <div class="sidebar-logo">
        <h1><span class="hal-dot"></span>ARIA</h1>
        <div class="version">v1.0 mainframe</div>
      </div>
      <div class="sidebar-nav">${navItemsHTML}</div>
      <div class="sidebar-footer">
        <button class="logout-btn" onclick="doLogout()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Logout
        </button>
      </div>
    </div>

    <div class="main-content">
      <!-- Overview Section -->
      <div class="section" id="section-overview">
        <div class="section-header">System Overview</div>
        <div id="overview-content">
          <div style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
        </div>
      </div>

      <!-- Chat Section -->
      <div class="section" id="section-chat">
        <div class="chat-header">
          <div class="chat-stats">
            <span>Msgs <b class="cv" id="st-m">0</b></span>
            <span>Tokens <b class="cv" id="st-t">0</b></span>
            <span>Cost <b class="cv" id="st-c">$0.00</b></span>
          </div>
          <div class="chat-actions">
            <button class="chat-btn" onclick="showQr()" title="QR Code">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/><path d="M14 14h3v3"/></svg>
              <span>QR</span>
            </button>
            <button class="chat-btn" onclick="doReset()" title="Reset">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
              <span>Reset</span>
            </button>
          </div>
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
        <div id="input-area">
          <textarea id="msg-input" placeholder="Message ARIA..." rows="1"></textarea>
          <button id="send-btn" onclick="doSend()">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>

      <!-- Memory Section -->
      <div class="section" id="section-memory">
        <div class="section-header">Memory Explorer</div>
        <div id="memory-content">
          <div style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
        </div>
      </div>

      <!-- Requests Section -->
      <div class="section" id="section-requests">
        <div class="section-header">Incoming Requests</div>
        <div id="requests-content">
          <div style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
        </div>
      </div>

      <!-- Integrations Section -->
      <div class="section" id="section-integrations">
        <div class="section-header">Integrations</div>
        <div id="integrations-content">
          <div style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
        </div>
      </div>

      <!-- Agents Section -->
      <div class="section" id="section-ai-providers">
        <div class="section-header">Agents &amp; Sub-Agents</div>
        <div id="ai-providers-content">
          <div style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
        </div>
      </div>

      <!-- Settings Section -->
      <div class="section" id="section-settings">
        <div class="section-header">Settings</div>
        <div id="settings-content">
          <div style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
        </div>
      </div>
    </div>

    <!-- Mobile Nav -->
    <div class="mobile-nav">
      <div class="mobile-nav-inner">${mobileNavHTML}</div>
    </div>
  </div>

  <!-- QR Modal -->
  <div id="qr-modal" onclick="hideQr()">
    <div class="qr-box" onclick="event.stopPropagation()">
      <h2>Mobile Access</h2>
      <img id="qr-img" alt="QR Code">
      <p id="qr-url"></p>
      <button class="close-btn" onclick="hideQr()">Close</button>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <script>
    // ── State ──
    let token = localStorage.getItem('agent_token');
    let busy = false, totTok = 0, totCost = 0, nMsg = 0;
    let renderTimer = null;
    let refreshInterval = null;
    let currentSection = 'overview';
    let chatLoaded = false;

    // ── Markdown setup ──
    marked.setOptions({ breaks: true, gfm: true, highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    }});

    const msgEl = document.getElementById('messages');
    const msgInput = document.getElementById('msg-input');
    const sendBtn = document.getElementById('send-btn');
    const fab = document.getElementById('scroll-fab');

    // ── Auth ──
    document.getElementById('pw-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') doLogin();
    });

    if (token) {
      fetch('/api/auth-check', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => r.json()).then(d => d.authenticated ? showApp() : resetAuth()).catch(resetAuth);
    }

    function resetAuth() {
      localStorage.removeItem('agent_token'); token = null;
      document.getElementById('login').style.display = 'flex';
      document.getElementById('app').classList.remove('visible');
    }

    function showApp() {
      document.getElementById('login').style.display = 'none';
      document.getElementById('app').classList.add('visible');
      // Route from hash or default
      const hash = location.hash.replace('#', '') || 'overview';
      navigate(hash, true);
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
        else err.textContent = d.error || 'Access denied';
      } catch { err.textContent = 'Connection error'; }
    }

    function doLogout() {
      localStorage.removeItem('agent_token'); token = null;
      if (refreshInterval) clearInterval(refreshInterval);
      resetAuth();
    }

    // ── Navigation ──
    function navigate(section, skipHash) {
      const valid = ['overview','chat','memory','requests','integrations','ai-providers','settings'];
      if (!valid.includes(section)) section = 'overview';
      currentSection = section;
      if (!skipHash) location.hash = section;

      // Update nav active states
      document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.section === section);
      });
      document.querySelectorAll('.mob-nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.section === section);
      });

      // Show/hide sections
      document.querySelectorAll('.section').forEach(el => {
        el.classList.toggle('active', el.id === 'section-' + section);
      });

      // Load section data
      if (section === 'overview') loadOverview();
      else if (section === 'chat' && !chatLoaded) { loadHistory(); chatLoaded = true; }
      else if (section === 'memory') loadMemory();
      else if (section === 'requests') loadRequests();
      else if (section === 'integrations') loadIntegrations();
      else if (section === 'ai-providers') loadProviders();
      else if (section === 'settings') loadSettings();

      // Auto-refresh for overview
      if (refreshInterval) clearInterval(refreshInterval);
      if (section === 'overview') {
        refreshInterval = setInterval(loadOverview, 30000);
      }

      // Focus chat input
      if (section === 'chat') setTimeout(() => msgInput.focus(), 100);
    }

    window.addEventListener('hashchange', () => {
      const hash = location.hash.replace('#', '') || 'overview';
      if (hash !== currentSection) navigate(hash, true);
    });

    // ── Chat input handlers ──
    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
    });
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    msgEl.addEventListener('scroll', () => {
      const atBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 80;
      fab.style.display = atBottom ? 'none' : 'flex';
    });

    // ── Helpers ──
    function authHeaders() { return { Authorization: 'Bearer ' + token }; }
    function jsonHeaders() { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }; }

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
    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (d.toDateString() === now.toDateString()) return time;
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
    }
    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function stat(val, label) {
      return '<div class="stat"><div class="num">' + val + '</div><div class="label">' + label + '</div></div>';
    }
    function kv(k, v, cls) {
      return '<div class="kv"><span class="k">' + k + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + v + '</span></div>';
    }
    function wmField(label, val) {
      return '<div class="wm-field"><div class="wm-label">' + label + '</div><div class="wm-val">' + esc(val) + '</div></div>';
    }
    let _nodeCounter = 0;
    function renderNode(n, pinned, ts) {
      const nid = 'node-' + (_nodeCounter++);
      const isTruncated = n.content.length > 300;
      let h = '<div class="node" id="' + nid + '"><div class="node-hdr">';
      h += '<span class="type-badge ' + n.type + '">' + n.type + '</span>';
      if (pinned) h += '<span class="pinned-icon">pinned</span>';
      h += '<span class="str">' + n.strength.toFixed(2);
      h += ' <span class="str-bar"><span class="str-fill" style="width:' + (n.strength * 100) + '%"></span></span>';
      h += '</span>';
      if (n.accessCount) h += '<span class="str" style="margin-left:auto">' + n.accessCount + ' access</span>';
      if (ts) h += '<span class="str" style="margin-left:auto">' + timeAgo(ts) + '</span>';
      h += '</div>';
      h += '<div class="content' + (isTruncated ? ' truncated' : '') + '" data-full="' + esc(n.content) + '">';
      h += esc(n.content.slice(0,300)) + (isTruncated ? '...' : '');
      h += '</div>';
      if (isTruncated) {
        h += '<span class="expand-hint" onclick="toggleNodeExpand(\'' + nid + '\')">show more</span>';
      }
      if (n.tags && n.tags.length) {
        h += '<div class="tags">';
        for (const t of n.tags) h += '<span class="tag">' + esc(t) + '</span>';
        h += '</div>';
      }
      h += '</div>';
      return h;
    }

    function toggleNodeExpand(nid) {
      const node = document.getElementById(nid);
      if (!node) return;
      const content = node.querySelector('.content');
      const hint = node.querySelector('.expand-hint');
      const full = content.dataset.full;
      if (content.classList.contains('truncated')) {
        content.textContent = full;
        content.classList.remove('truncated');
        hint.textContent = 'show less';
      } else {
        content.textContent = full.slice(0, 300) + '...';
        content.classList.add('truncated');
        hint.textContent = 'show more';
      }
    }

    // ── Overview Section ──
    async function loadOverview() {
      try {
        const res = await fetch('/api/dashboard', { headers: authHeaders() });
        if (res.status === 401) { resetAuth(); return; }
        const d = await res.json();
        renderOverview(d);
      } catch(e) {
        document.getElementById('overview-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderOverview(d) {
      const bs = d.brainState || {};
      const wm = d.workingMemory || {};
      const g = d.graph || {};

      const failures = bs.consecutiveFailures || 0;
      const healthy = failures < 5;

      let html = '<div class="card-grid">';

      // System status card
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>System Status</h2>';
      html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">';
      html += '<span class="status-dot ' + (healthy ? (failures > 0 ? 'warn' : 'ok') : 'err') + '"></span>';
      html += '<span style="font-family:var(--mono);font-size:13px;color:var(--text)">' + (healthy ? (failures > 0 ? 'Degraded' : 'Operational') : 'Unhealthy') + '</span>';
      html += '</div>';
      html += kv('Queue Depth', d.queueDepth ?? 0);
      html += kv('Consecutive Failures', failures, failures > 0 ? (failures < 5 ? 'warn' : 'bad') : 'good');
      html += kv('Pending Self-Mod', bs.pendingSelfMod ? 'Yes' : 'No', bs.pendingSelfMod ? 'warn' : '');
      html += '</div>';

      // Brain activity card
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/></svg>Brain Activity</h2>';
      html += kv('Total Thinks', bs.totalThinks || 0);
      html += kv('Total Cost', '$' + (bs.totalCost || 0).toFixed(2));
      html += kv('Last Think', timeAgo(bs.lastThinkTick));
      html += kv('Last Consolidate', timeAgo(bs.lastConsolidateTick));
      html += kv('Last Reflect', timeAgo(bs.lastReflectTick));
      html += kv('Messages Today', (bs.messagesToday || 0) + '/5');
      html += kv('Last Message', timeAgo(bs.lastMessageTime));
      html += '</div>';

      // Integrations overview card
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>Integrations</h2>';
      const wa = d.whatsapp || {};
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
      html += '<span class="status-dot ' + (wa.connected ? 'ok' : 'err') + '"></span>';
      html += '<span style="font-size:13px;color:var(--text)">WhatsApp</span>';
      html += '<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-left:auto">' + (wa.contactCount || 0) + ' contacts</span>';
      html += '</div>';
      const gmail = d.gmail || {};
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<span class="status-dot ' + ((gmail.authenticated || 0) > 0 ? 'ok' : 'warn') + '"></span>';
      html += '<span style="font-size:13px;color:var(--text)">Gmail</span>';
      html += '<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-left:auto">' + (gmail.authenticated || 0) + '/' + (gmail.total || 0) + ' active</span>';
      html += '</div>';
      const slack = d.slack || {};
      html += '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">';
      html += '<span class="status-dot ' + ((slack.authenticated || 0) > 0 ? 'ok' : 'warn') + '"></span>';
      html += '<span style="font-size:13px;color:var(--text)">Slack</span>';
      html += '<span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-left:auto">' + (slack.authenticated || 0) + '/' + (slack.total || 0) + ' active</span>';
      html += '</div>';
      html += '</div>';

      // Claude usage card
      const cu = d.claudeUsage || {};
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/><circle cx="12" cy="12" r="5"/></svg>Claude Usage</h2>';
      const chatCost = cu.totalCostUsd || 0;
      const brainCost = bs.totalCost || 0;
      const combinedCost = chatCost + brainCost;
      html += '<div class="stat-grid" style="margin-bottom:12px">';
      html += stat('$' + combinedCost.toFixed(2), 'Total Cost');
      html += stat((cu.totalTokens || 0).toLocaleString(), 'Chat Tokens');
      html += stat(cu.totalResponses || 0, 'Chat Calls');
      html += stat(bs.totalThinks || 0, 'Brain Thinks');
      html += '</div>';
      html += '<h4 style="margin:0 0 8px;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:1px">Today</h4>';
      html += kv('Responses', cu.todayResponses || 0);
      html += kv('Tokens', (cu.todayTokens || 0).toLocaleString());
      html += kv('Cost', '$' + (cu.todayCostUsd || 0).toFixed(4));
      html += '<h4 style="margin:12px 0 8px;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:1px">Averages</h4>';
      const avgDur = cu.avgDurationMs || 0;
      html += kv('Response Time', avgDur >= 1000 ? (avgDur / 1000).toFixed(1) + 's' : avgDur.toFixed(0) + 'ms');
      html += kv('Cost / Response', '$' + (cu.avgCostUsd || 0).toFixed(4));
      html += kv('Turns / Response', (cu.avgTurns || 0).toFixed(1));
      html += '<h4 style="margin:12px 0 8px;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:1px">Breakdown</h4>';
      html += kv('Chat Cost', '$' + chatCost.toFixed(4));
      html += kv('Brain Cost', '$' + brainCost.toFixed(2));
      html += kv('Input Tokens', (cu.inputTokens || 0).toLocaleString());
      html += kv('Output Tokens', (cu.outputTokens || 0).toLocaleString());
      html += kv('Sources', (cu.webMessages || 0) + ' web, ' + (cu.whatsappMessages || 0) + ' WhatsApp');
      html += kv('History Span', (cu.historyDays || 0) + ' day' + ((cu.historyDays || 0) !== 1 ? 's' : ''));
      html += '</div>';

      // Working memory card
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>Working Memory</h2>';
      if (wm.currentContext || wm.mood || (wm.shortTermTracking && wm.shortTermTracking.length)) {
        if (wm.mood) html += wmField('Mood', wm.mood);
        if (wm.currentContext) html += wmField('Context', wm.currentContext);
        if (wm.shortTermTracking && wm.shortTermTracking.length) html += wmField('Tracking', wm.shortTermTracking.join(', '));
        html += kv('Last Updated', timeAgo(wm.lastUpdated));
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:10px 0">Awaiting first think tick</div>';
      }
      html += '</div>';

      html += '</div>'; // close card-grid

      // Quick stats row
      html += '<div class="stat-grid" style="margin-top:8px">';
      html += stat(g.nodeCount || 0, 'Nodes');
      html += stat(g.edgeCount || 0, 'Edges');
      html += stat(bs.totalThinks || 0, 'Thinks');
      html += stat('$' + (bs.totalCost || 0).toFixed(2), 'Cost');
      html += stat((d.whitelistCount || 0), 'Whitelist');
      html += stat((d.scheduledCount || 0), 'Scheduled');
      html += '</div>';

      document.getElementById('overview-content').innerHTML = html;
    }

    // ── Memory Section ──
    async function loadMemory() {
      try {
        const res = await fetch('/api/aria/status', { headers: authHeaders() });
        if (res.status === 401) { resetAuth(); return; }
        const d = await res.json();
        renderMemory(d);
      } catch(e) {
        document.getElementById('memory-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderMemory(d) {
      const g = d.graph || {};
      let html = '';

      // Graph stats
      if (g.byType) {
        html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>Graph Statistics</h2>';
        html += '<div class="stat-grid">';
        html += stat(g.nodeCount || 0, 'Nodes');
        html += stat(g.edgeCount || 0, 'Edges');
        html += stat((g.avgStrength || 0).toFixed(3), 'Avg Str');
        html += stat((g.pinnedNodes || []).length, 'Pinned');
        html += '</div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">';
        for (const [type, count] of Object.entries(g.byType)) {
          html += '<span class="type-badge ' + type + '">' + type + ': ' + count + '</span>';
        }
        html += '</div></div>';
      }

      // Pinned memories
      if (g.pinnedNodes && g.pinnedNodes.length) {
        html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 01-1.11-1.65l-.54-4.81A1 1 0 018.34 3h7.32a1 1 0 01.99 1.1l-.54 5.01A2 2 0 0115 10.76L12 14l-3-3.24z"/></svg>Core Directives</h2>';
        for (const n of g.pinnedNodes) html += renderNode(n, true);
        html += '</div>';
      }

      // Strongest
      if (g.strongestNodes && g.strongestNodes.length) {
        html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>Strongest Memories</h2>';
        for (const n of g.strongestNodes.slice(0, 10)) html += renderNode(n);
        html += '</div>';
      }

      // Recent
      if (g.recentNodes && g.recentNodes.length) {
        html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Recent Memories</h2>';
        for (const n of g.recentNodes) html += renderNode(n, false, n.createdAt);
        html += '</div>';
      }

      if (!html) html = '<div style="color:var(--text-ghost);text-align:center;padding:40px">No memories yet</div>';
      document.getElementById('memory-content').innerHTML = html;
    }

    // ── Requests Section ──
    async function loadRequests() {
      try {
        const res = await fetch('/api/actionable-requests', { headers: authHeaders() });
        if (res.status === 401) { resetAuth(); return; }
        const requests = await res.json();
        renderRequests(requests);
      } catch(e) {
        document.getElementById('requests-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderRequests(requests) {
      const pending = requests.filter(r => r.status === 'pending_confirmation');
      const autoExec = requests.filter(r => r.status === 'auto_executed');
      const resolved = requests.filter(r => r.status === 'approved' || r.status === 'rejected');

      let html = '';

      // Pending confirmation
      html += '<div class="card"><h2 style="display:flex;align-items:center;gap:8px">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2" style="width:18px;height:18px"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>';
      html += 'Awaiting Confirmation';
      if (pending.length > 0) html += '<span style="background:var(--yellow);color:#000;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:700;margin-left:4px">' + pending.length + '</span>';
      html += '</h2>';
      if (pending.length === 0) {
        html += '<p style="color:var(--text-ghost);font-size:13px">No pending requests</p>';
      } else {
        pending.forEach(r => { html += renderRequestItem(r, true); });
      }
      html += '</div>';

      // Auto-executed
      html += '<div class="card"><h2 style="display:flex;align-items:center;gap:8px">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" style="width:18px;height:18px"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
      html += 'Auto-Executed';
      if (autoExec.length > 0) html += '<span style="font-size:11px;color:var(--text-muted);margin-left:4px">' + autoExec.length + '</span>';
      html += '</h2>';
      if (autoExec.length === 0) {
        html += '<p style="color:var(--text-ghost);font-size:13px">No auto-executed requests yet</p>';
      } else {
        autoExec.slice(-20).reverse().forEach(r => { html += renderRequestItem(r, false); });
      }
      html += '</div>';

      // Resolved (approved/rejected)
      if (resolved.length > 0) {
        html += '<div class="card"><h2 style="display:flex;align-items:center;gap:8px">';
        html += '<svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" style="width:18px;height:18px"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>';
        html += 'Resolved';
        html += '<span style="font-size:11px;color:var(--text-muted);margin-left:4px">' + resolved.length + '</span>';
        html += '</h2>';
        resolved.slice(-20).reverse().forEach(r => { html += renderRequestItem(r, false); });
        html += '</div>';
      }

      document.getElementById('requests-content').innerHTML = html;
    }

    function renderRequestItem(r, showActions) {
      const date = new Date(r.timestamp);
      const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const cats = (r.categories || []).map(c =>
        '<span class="type-badge" style="font-size:10px;padding:1px 6px">' + c + '</span>'
      ).join(' ');
      const statusColors = {
        pending_confirmation: 'var(--yellow)',
        auto_executed: 'var(--green)',
        approved: 'var(--cyan)',
        rejected: 'var(--red)',
      };
      const statusLabel = r.status.replace('_', ' ');
      const ctx = r.isGroup ? ' in ' + (r.groupName || '?') : '';

      let html = '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--bg-surface)">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<span style="font-weight:600;color:var(--text);font-size:13px">' + (r.senderName || 'Unknown') + '</span>';
      html += '<span style="color:var(--text-ghost);font-size:11px">' + ctx + '</span>';
      html += '</div>';
      html += '<div style="display:flex;align-items:center;gap:8px">';
      html += '<span style="color:' + (statusColors[r.status] || 'var(--text-muted)') + ';font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">' + statusLabel + '</span>';
      html += '<span style="color:var(--text-ghost);font-size:11px;font-family:var(--mono)">' + day + ' ' + time + '</span>';
      html += '</div></div>';
      html += '<div style="color:var(--text-dim);font-size:13px;margin-bottom:8px;line-height:1.4;font-style:italic">"' + (r.text || '').slice(0, 200) + '"</div>';
      html += '<div style="display:flex;justify-content:space-between;align-items:center">';
      html += '<div>' + cats + '</div>';
      if (showActions) {
        html += '<div style="display:flex;gap:6px">';
        html += '<button onclick="approveRequest(\'' + r.id + '\')" style="background:var(--green);color:#000;border:none;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer">Approve</button>';
        html += '<button onclick="rejectRequest(\'' + r.id + '\')" style="background:var(--red);color:#fff;border:none;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer">Reject</button>';
        html += '</div>';
      }
      html += '</div></div>';
      return html;
    }

    async function approveRequest(id) {
      try {
        await fetch('/api/actionable-requests/' + id + '/approve', { method: 'POST', headers: authHeaders() });
        loadRequests();
      } catch(e) { alert('Failed: ' + e.message); }
    }

    async function rejectRequest(id) {
      try {
        await fetch('/api/actionable-requests/' + id + '/reject', { method: 'POST', headers: authHeaders() });
        loadRequests();
      } catch(e) { alert('Failed: ' + e.message); }
    }

    // ── Integrations Section ──
    async function loadIntegrations() {
      try {
        const [dashRes, schedRes, wlRes, calConfigRes, calStatusRes] = await Promise.all([
          fetch('/api/dashboard', { headers: authHeaders() }),
          fetch('/api/scheduled', { headers: authHeaders() }),
          fetch('/api/whitelist', { headers: authHeaders() }),
          fetch('/api/calendar/config', { headers: authHeaders() }),
          fetch('/api/calendar/status', { headers: authHeaders() }),
        ]);
        if (dashRes.status === 401) { resetAuth(); return; }
        const dash = await dashRes.json();
        const scheduled = await schedRes.json();
        const whitelist = await wlRes.json();
        const calConfig = calConfigRes.ok ? await calConfigRes.json() : { calendars: [] };
        const calStatus = calStatusRes.ok ? await calStatusRes.json() : { enabled: false, accounts: [] };
        renderIntegrations(dash, scheduled, whitelist, calConfig, calStatus);
      } catch(e) {
        document.getElementById('integrations-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderIntegrations(dash, scheduled, whitelist, calConfig, calStatus) {
      const wa = dash.whatsapp || {};
      const gmail = dash.gmail || {};
      const gmailAccounts = dash.gmailAccounts || [];
      let html = '';

      // WhatsApp
      html += '<div class="intg-card"><div class="intg-header">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2" style="width:20px;height:20px"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>';
      html += '<h3>WhatsApp</h3>';
      html += '<span class="intg-status ' + (wa.connected ? 'online' : 'offline') + '">' + (wa.connected ? 'Connected' : 'Disconnected') + '</span>';
      html += '</div>';
      html += kv('Contacts', wa.contactCount || 0);
      html += '<div class="btn-row">';
      html += '<button class="btn" onclick="syncContacts()">Sync Contacts</button>';
      html += '<button class="btn" onclick="showQr()">Show QR</button>';
      html += '</div>';

      // Contact whitelist (WhatsApp)
      html += '<h4 style="margin:16px 0 8px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:1px">Contact Whitelist &amp; Permissions</h4>';
      if (whitelist.length) {
        for (const c of whitelist) {
          const p = c.permissions;
          const hasPerms = p && p.acceptCommands;
          html += '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--bg-surface)">';
          // Header row: name, jid, actions
          html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:' + (hasPerms ? '10' : '0') + 'px">';
          html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
          html += '<span style="font-weight:600;color:var(--text);font-size:13px">' + esc(c.name) + '</span>';
          html += '<span style="color:var(--text-ghost);font-size:11px;font-family:var(--mono)">' + esc(c.jid) + '</span>';
          if (hasPerms) html += '<span style="font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(0,229,255,0.1);color:var(--cyan);border:1px solid rgba(0,229,255,0.2)">commands enabled</span>';
          html += '</div>';
          html += '<div style="display:flex;align-items:center;gap:6px">';
          html += '<button style="background:none;border:1px solid var(--border);color:var(--text-dim);padding:3px 10px;border-radius:4px;font-size:11px;cursor:pointer;font-family:var(--mono)" onclick="togglePermissions(\'' + esc(c.jid) + '\',' + (hasPerms ? 'false' : 'true') + ')">' + (hasPerms ? 'disable' : 'enable') + '</button>';
          html += '<button class="wl-rm" onclick="removeWhitelist(\'' + esc(c.jid) + '\')">Remove</button>';
          html += '</div></div>';
          // Permission editor (only shown when commands enabled)
          if (hasPerms) {
            html += renderPermEditor(c.jid, p);
          }
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No whitelisted contacts</div>';
      }
      html += '<div class="wl-add-form">';
      html += '<input type="text" id="wl-jid" placeholder="JID (e.g. 123@s.whatsapp.net)">';
      html += '<input type="text" id="wl-name" placeholder="Name">';
      html += '<button class="btn primary" onclick="addWhitelist()">Add</button>';
      html += '</div>';
      html += '</div>';

      // Gmail
      html += '<div class="intg-card"><div class="intg-header">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="#EA4335" stroke-width="2" style="width:20px;height:20px"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
      html += '<h3>Gmail</h3>';
      html += '<span class="intg-status ' + ((gmail.authenticated || 0) > 0 ? 'online' : 'pending') + '">' + (gmail.authenticated || 0) + '/' + (gmail.total || 0) + ' Active</span>';
      html += '</div>';
      if (gmailAccounts.length) {
        for (const acc of gmailAccounts) {
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03)">';
          html += '<span class="status-dot ' + (acc.authenticated ? 'ok' : 'warn') + '" style="flex-shrink:0"></span>';
          html += '<span style="font-size:13px;color:var(--text)">' + esc(acc.email) + '</span>';
          if (!acc.authenticated) html += '<a href="/gmail/auth/' + esc(acc.id) + '" class="btn" style="margin-left:auto;padding:4px 10px;font-size:11px">Authorize</a>';
          else html += '<span style="font-family:var(--mono);font-size:10px;color:var(--text-muted);margin-left:auto">Last poll: ' + (acc.lastPoll ? timeAgo(acc.lastPoll) : 'never') + '</span>';
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No Gmail accounts configured</div>';
      }
      html += '</div>';

      // Calendar
      const calEnabled = calStatus && calStatus.enabled;
      const calAccounts = (calStatus && calStatus.accounts) || [];
      const calCalendars = (calConfig && calConfig.calendars) || [];
      html += '<div class="intg-card"><div class="intg-header">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="#4285F4" stroke-width="2" style="width:20px;height:20px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
      html += '<h3>Calendar</h3>';
      html += '<span class="intg-status ' + (calEnabled ? 'online' : 'offline') + '">' + (calEnabled ? 'Enabled' : 'Disabled') + '</span>';
      html += '</div>';

      // Calendar accounts with scope info
      if (gmailAccounts.length) {
        for (const acc of gmailAccounts) {
          const calAcc = calAccounts.find(function(ca) { return ca.id === acc.id; });
          const hasWrite = acc.hasCalendarWrite;
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03)">';
          html += '<span class="status-dot ' + (hasWrite ? 'ok' : 'warn') + '" style="flex-shrink:0"></span>';
          html += '<span style="font-size:13px;color:var(--text)">' + esc(acc.email) + '</span>';
          if (!hasWrite) {
            html += '<a href="/gmail/auth/' + esc(acc.id) + '" class="btn" style="margin-left:auto;padding:4px 10px;font-size:11px">Re-authorize</a>';
          } else {
            html += '<span style="font-family:var(--mono);font-size:10px;color:var(--text-muted);margin-left:auto">';
            html += calAcc && calAcc.lastSync ? 'Last sync: ' + timeAgo(calAcc.lastSync) : 'No sync yet';
            html += '</span>';
          }
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No Gmail accounts with calendar access</div>';
      }

      // Tagged calendars config
      html += '<h4 style="margin:16px 0 8px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:1px">Calendar Tags</h4>';
      if (calCalendars.length) {
        for (const cal of calCalendars) {
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03)">';
          html += '<span style="font-size:13px;color:var(--text)">' + esc(cal.name) + '</span>';
          html += '<span style="font-family:var(--mono);font-size:10px;color:var(--text-muted);margin-left:auto">' + (cal.tag ? esc(cal.tag) : 'untagged') + '</span>';
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No calendars tagged yet</div>';
      }

      // Load calendars buttons
      if (gmailAccounts.length) {
        html += '<div class="btn-row" style="margin-top:12px">';
        for (const acc of gmailAccounts) {
          if (acc.hasCalendarWrite) {
            html += '<button class="btn" onclick="loadCalendarsForAccount(\'' + esc(acc.id) + '\')">Load Calendars (' + esc(acc.email) + ')</button>';
          }
        }
        html += '</div>';
      }

      // Container for dynamically loaded calendar list
      html += '<div id="calendar-list-container"></div>';
      html += '</div>';

      // Slack
      const slackStatus = dash.slack || {};
      const slackWorkspaces = dash.slackWorkspaces || [];
      html += '<div class="intg-card"><div class="intg-header">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="#E01E5A" stroke-width="2" style="width:20px;height:20px"><path d="M14.5 2c-1.38 0-2.5 1.12-2.5 2.5V9h4.5C17.88 9 19 7.88 19 6.5S17.88 4 16.5 4H14.5V2z"/><path d="M2 14.5C2 15.88 3.12 17 4.5 17H9v-4.5C9 11.12 7.88 10 6.5 10S4 11.12 4 12.5H2z"/><path d="M9.5 22c1.38 0 2.5-1.12 2.5-2.5V15H7.5C6.12 15 5 16.12 5 17.5S6.12 20 7.5 20h2v2z"/><path d="M22 9.5c0-1.38-1.12-2.5-2.5-2.5H15v4.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9.5z"/></svg>';
      html += '<h3>Slack</h3>';
      html += '<span class="intg-status ' + ((slackStatus.authenticated || 0) > 0 ? 'online' : 'pending') + '">' + (slackStatus.authenticated || 0) + '/' + (slackStatus.total || 0) + ' Active</span>';
      html += '</div>';
      if (slackWorkspaces.length) {
        for (const ws of slackWorkspaces) {
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03)">';
          html += '<span class="status-dot ' + (ws.authenticated ? 'ok' : 'warn') + '" style="flex-shrink:0"></span>';
          html += '<span style="font-size:13px;color:var(--text)">' + esc(ws.teamName) + '</span>';
          if (ws.channelCount) html += '<span style="font-family:var(--mono);font-size:10px;color:var(--text-muted)">' + ws.channelCount + ' ch</span>';
          if (!ws.authenticated) html += '<a href="/slack/auth/' + esc(ws.id) + '" class="btn" style="margin-left:auto;padding:4px 10px;font-size:11px">Authorize</a>';
          else html += '<span style="font-family:var(--mono);font-size:10px;color:var(--text-muted);margin-left:auto">Last poll: ' + (ws.lastPoll ? timeAgo(ws.lastPoll) : 'never') + '</span>';
          html += '<button class="wl-rm" onclick="removeSlackWorkspace(\'' + esc(ws.id) + '\')" title="Remove workspace">Remove</button>';
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No Slack workspaces configured</div>';
      }
      html += '<h4 style="margin:16px 0 8px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:1px">Add Workspace</h4>';
      html += '<div class="wl-add-form">';
      html += '<input type="text" id="slack-id" placeholder="Workspace ID (e.g. newstory)">';
      html += '<input type="text" id="slack-team" placeholder="Team name">';
      html += '<input type="text" id="slack-client-id" placeholder="Client ID">';
      html += '<input type="text" id="slack-client-secret" placeholder="Client Secret">';
      html += '<button class="btn primary" onclick="addSlackWorkspace()">Add</button>';
      html += '</div>';
      html += '</div>';

      // Scheduled messages
      html += '<div class="intg-card"><div class="intg-header">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
      html += '<h3>Scheduled Messages</h3>';
      html += '<span class="intg-status ' + (scheduled.length ? 'pending' : 'online') + '">' + scheduled.length + ' pending</span>';
      html += '</div>';
      if (scheduled.length) {
        for (const m of scheduled) {
          html += '<div class="sched-item">';
          html += '<div style="display:flex;justify-content:space-between;align-items:center">';
          html += '<span class="sched-target">' + esc(m.targetJid) + '</span>';
          html += '<span class="sched-time">' + fmtDate(m.deliverAt) + '</span>';
          html += '</div>';
          html += '<div class="sched-msg">' + esc(m.message.slice(0, 120)) + (m.message.length > 120 ? '...' : '') + '</div>';
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No scheduled messages</div>';
      }
      html += '</div>';

      document.getElementById('integrations-content').innerHTML = html;
    }

    // ── Settings Section ──
    let _characterPresets = [];
    let _currentCharacterType = 'default';
    let _currentCharacterCustom = '';

    async function loadSettings() {
      try {
        const [dashRes, cfgRes, queueRes] = await Promise.all([
          fetch('/api/dashboard', { headers: authHeaders() }),
          fetch('/api/brain-config', { headers: authHeaders() }),
          fetch('/api/improve-queue', { headers: authHeaders() }),
        ]);
        if (dashRes.status === 401) { resetAuth(); return; }
        const dash = await dashRes.json();
        const cfg = await cfgRes.json();
        const queueData = queueRes.ok ? await queueRes.json() : { queue: [], history: [] };
        _characterPresets = cfg.characterPresets || [];
        _currentCharacterType = cfg.config.characterType || 'default';
        _currentCharacterCustom = cfg.config.characterCustomPrompt || '';
        renderSettings(dash, queueData);
      } catch(e) {
        document.getElementById('settings-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    async function saveCharacter() {
      const sel = document.getElementById('char-select');
      const textarea = document.getElementById('char-custom');
      const type = sel.value;
      const custom = type === 'custom' ? textarea.value : null;
      try {
        const res = await fetch('/api/brain-config', {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ characterType: type, characterCustomPrompt: custom })
        });
        if (res.ok) {
          _currentCharacterType = type;
          _currentCharacterCustom = custom || '';
          const statusEl = document.getElementById('char-status');
          statusEl.textContent = 'Saved!';
          statusEl.style.color = 'var(--green)';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        }
      } catch(e) {
        const statusEl = document.getElementById('char-status');
        statusEl.textContent = 'Failed to save';
        statusEl.style.color = 'var(--red)';
      }
    }

    function onCharacterChange() {
      const sel = document.getElementById('char-select');
      const customWrap = document.getElementById('char-custom-wrap');
      const descEl = document.getElementById('char-desc');
      if (sel.value === 'custom') {
        customWrap.style.display = 'block';
        descEl.textContent = 'Write your own personality description below.';
      } else {
        customWrap.style.display = 'none';
        const preset = _characterPresets.find(p => p.name === sel.value);
        descEl.textContent = preset ? preset.description : '';
      }
    }

    async function approveImprovement(id) {
      try {
        const res = await fetch('/api/improve-queue/' + id + '/approve', { method: 'POST', headers: authHeaders() });
        if (res.ok) loadSettings();
      } catch(e) { console.error('Approve failed:', e); }
    }

    async function rejectImprovement(id) {
      try {
        const res = await fetch('/api/improve-queue/' + id + '/reject', { method: 'POST', headers: authHeaders() });
        if (res.ok) loadSettings();
      } catch(e) { console.error('Reject failed:', e); }
    }

    function renderSettings(dash, queueData) {
      const si = dash.selfImprove || {};
      const queue = (queueData && queueData.queue) || [];
      const history = (queueData && queueData.history) || [];
      let html = '';

      // Character type
      html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 10-16 0"/></svg>Character</h2>';
      html += '<div style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Choose a personality preset or write your own.</div>';
      html += '<select id="char-select" onchange="onCharacterChange()" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:13px;font-family:var(--mono);margin-bottom:8px">';
      for (const p of _characterPresets) {
        const selected = p.name === _currentCharacterType ? ' selected' : '';
        html += '<option value="' + esc(p.name) + '"' + selected + '>' + esc(p.label) + '</option>';
      }
      html += '<option value="custom"' + (_currentCharacterType === 'custom' ? ' selected' : '') + '>Custom</option>';
      html += '</select>';
      const activePreset = _characterPresets.find(p => p.name === _currentCharacterType);
      html += '<div id="char-desc" style="color:var(--text-muted);font-size:12px;margin-bottom:10px">' + esc(_currentCharacterType === 'custom' ? 'Write your own personality description below.' : (activePreset ? activePreset.description : '')) + '</div>';
      html += '<div id="char-custom-wrap" style="display:' + (_currentCharacterType === 'custom' ? 'block' : 'none') + '">';
      html += '<textarea id="char-custom" rows="6" style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;font-size:12px;font-family:var(--mono);resize:vertical;margin-bottom:8px" placeholder="Describe the personality traits and voice...">' + esc(_currentCharacterCustom) + '</textarea>';
      html += '</div>';
      html += '<div class="btn-row" style="align-items:center">';
      html += '<button class="btn" onclick="saveCharacter()">Save Character</button>';
      html += '<span id="char-status" style="font-size:12px;font-family:var(--mono);margin-left:10px"></span>';
      html += '</div>';
      html += '</div>';

      // Self-improvement
      html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Self-Improvement</h2>';
      html += kv('Boot Counter', si.bootCounter || 0, (si.bootCounter || 0) > 1 ? 'warn' : '');
      html += kv('Last Good Commit', si.lastGoodCommit ? si.lastGoodCommit.slice(0, 8) : 'none');
      if (si.pendingTask) {
        html += '<div class="si-task pending" style="margin-top:10px">';
        html += '<div class="si-label">Pending Task</div>';
        html += '<div class="si-val">' + esc(si.pendingTask.description) + '</div>';
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--mono)">Files: ' + (si.pendingTask.files || []).join(', ') + '</div>';
        html += '</div>';
      }
      if (si.lastResult) {
        const r = si.lastResult;
        html += '<div class="si-task ' + (r.success ? 'success' : 'failed') + '" style="margin-top:10px">';
        html += '<div class="si-label">Last Result — ' + (r.success ? '<span style="color:var(--green)">Success</span>' : '<span style="color:var(--red)">Failed</span>') + '</div>';
        html += '<div class="si-val">' + esc(r.description) + '</div>';
        if (r.prUrl) html += '<a style="color:var(--cyan);text-decoration:none;font-size:12px;font-family:var(--mono)" href="' + esc(r.prUrl) + '" target="_blank">View PR</a>';
        if (r.completedAt) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--mono)">' + fmtDate(r.completedAt) + '</div>';
        html += '</div>';
      }
      if (!si.pendingTask && !si.lastResult && queue.length === 0 && history.length === 0) {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:10px 0">No self-improvement activity yet</div>';
      }

      // Improvement queue
      const pending = queue.filter(function(i) { return i.status === 'pending'; });
      const running = queue.filter(function(i) { return i.status === 'running' || i.status === 'approved'; });
      if (pending.length > 0) {
        html += '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">';
        html += '<div style="font-size:12px;font-family:var(--mono);color:var(--text-muted);margin-bottom:8px">PROPOSALS AWAITING REVIEW (' + pending.length + ')</div>';
        for (var qi = 0; qi < pending.length; qi++) {
          var item = pending[qi];
          html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">';
          html += '<div style="font-size:13px;color:var(--text)">' + esc(item.task.description) + '</div>';
          html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--mono)">' + esc(item.task.rationale || '') + '</div>';
          if (item.task.files && item.task.files.length > 0) {
            html += '<div style="font-size:11px;color:var(--text-ghost);margin-top:2px;font-family:var(--mono)">Files: ' + esc(item.task.files.join(', ')) + '</div>';
          }
          html += '<div class="btn-row" style="margin-top:8px">';
          html += '<button class="btn" style="font-size:11px;padding:4px 12px" onclick="approveImprovement(\'' + esc(item.id) + '\')">Approve</button>';
          html += '<button class="btn danger" style="font-size:11px;padding:4px 12px" onclick="rejectImprovement(\'' + esc(item.id) + '\')">Reject</button>';
          html += '</div></div>';
        }
        html += '</div>';
      }
      if (running.length > 0) {
        html += '<div style="margin-top:8px">';
        for (var ri = 0; ri < running.length; ri++) {
          var rItem = running[ri];
          html += '<div style="font-size:12px;color:var(--yellow);font-family:var(--mono);padding:4px 0">';
          html += (rItem.status === 'running' ? 'Running' : 'Approved, waiting') + ': ' + esc(rItem.task.description.slice(0, 60));
          html += '</div>';
        }
        html += '</div>';
      }

      // Recent history
      var recentHistory = history.slice(0, 5);
      if (recentHistory.length > 0) {
        html += '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">';
        html += '<div style="font-size:12px;font-family:var(--mono);color:var(--text-muted);margin-bottom:8px">RECENT HISTORY</div>';
        for (var hi = 0; hi < recentHistory.length; hi++) {
          var hItem = recentHistory[hi];
          var statusColor = hItem.status === 'completed' ? 'var(--green)' : hItem.status === 'rejected' ? 'var(--text-ghost)' : 'var(--red)';
          html += '<div style="font-size:12px;font-family:var(--mono);padding:3px 0">';
          html += '<span style="color:' + statusColor + '">' + esc(hItem.status) + '</span> ';
          html += '<span style="color:var(--text-muted)">' + esc((hItem.task.description || '').slice(0, 50)) + '</span>';
          if (hItem.result && hItem.result.prUrl) {
            html += ' <a href="' + esc(hItem.result.prUrl) + '" target="_blank" style="color:var(--cyan);text-decoration:none">PR</a>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';

      // Session info
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Session</h2>';
      html += kv('Status', 'Active', 'good');
      html += '<div class="btn-row">';
      html += '<button class="btn danger" onclick="doLogout()">Logout</button>';
      html += '</div>';
      html += '</div>';

      document.getElementById('settings-content').innerHTML = html;
    }

    // ── Whitelist CRUD ──
    async function addWhitelist() {
      const jid = document.getElementById('wl-jid')?.value?.trim();
      const name = document.getElementById('wl-name')?.value?.trim();
      if (!jid || !name) return;
      try {
        await fetch('/api/whitelist', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ jid, name })
        });
        loadIntegrations();
      } catch {}
    }

    async function removeWhitelist(jid) {
      try {
        await fetch('/api/whitelist', {
          method: 'DELETE',
          headers: jsonHeaders(),
          body: JSON.stringify({ jid })
        });
        loadIntegrations();
      } catch {}
    }

    // ── Permission management ──
    const PERM_CATS = ['event','invitation','logistics','request','deadline','action_item'];

    function renderPermEditor(jid, perms) {
      const auto = perms.autoActions || [];
      const confirm = perms.confirmActions || [];
      const defMode = perms.defaultMode || 'confirm';
      const j = esc(jid);
      let h = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">';
      for (const cat of PERM_CATS) {
        const mode = auto.includes(cat) ? 'auto' : confirm.includes(cat) ? 'confirm' : defMode;
        const col = mode === 'auto' ? 'var(--green)' : 'var(--yellow)';
        h += '<button data-jid="' + j + '" data-cat="' + cat + '" data-mode="' + mode + '" onclick="cyclePerm(this)" ';
        h += 'style="display:flex;align-items:center;gap:5px;background:var(--bg-elevated);border:1px solid ' + col + ';color:var(--text);padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:var(--mono);transition:all 0.15s">';
        h += '<span style="width:6px;height:6px;border-radius:50%;background:' + col + '"></span>';
        h += cat + ' <span style="color:' + col + ';font-weight:600">' + mode + '</span></button>';
      }
      h += '</div>';
      h += '<div style="display:flex;align-items:center;gap:8px">';
      h += '<span style="color:var(--text-ghost);font-size:11px">Default for unlisted:</span>';
      h += '<select data-jid="' + j + '" id="def-' + j + '" onchange="savePerms(\'' + j + '\')" ';
      h += 'style="background:var(--bg-elevated);border:1px solid var(--border);color:var(--text);padding:3px 8px;border-radius:4px;font-size:11px;font-family:var(--mono)">';
      h += '<option value="confirm"' + (defMode === 'confirm' ? ' selected' : '') + '>confirm</option>';
      h += '<option value="ignore"' + (defMode === 'ignore' ? ' selected' : '') + '>ignore</option>';
      h += '</select>';
      h += '<span style="color:var(--text-ghost);font-size:10px;margin-left:8px">click category to toggle auto/confirm</span>';
      h += '</div>';
      return h;
    }

    function cyclePerm(btn) {
      const next = btn.dataset.mode === 'auto' ? 'confirm' : 'auto';
      btn.dataset.mode = next;
      const col = next === 'auto' ? 'var(--green)' : 'var(--yellow)';
      btn.style.borderColor = col;
      const spans = btn.querySelectorAll('span');
      spans[0].style.background = col;
      spans[1].style.color = col;
      spans[1].textContent = next;
      savePerms(btn.dataset.jid);
    }

    async function togglePermissions(jid, enable) {
      const perms = enable ? {
        acceptCommands: true,
        autoActions: ['event','logistics'],
        confirmActions: ['request','deadline','action_item'],
        defaultMode: 'confirm'
      } : null;
      try {
        await fetch('/api/whitelist/permissions', {
          method: 'PUT', headers: jsonHeaders(),
          body: JSON.stringify({ jid, permissions: perms })
        });
        loadIntegrations();
      } catch {}
    }

    async function savePerms(jid) {
      const btns = document.querySelectorAll('button[data-jid="' + jid + '"][data-cat]');
      const autoActions = [], confirmActions = [];
      btns.forEach(b => {
        if (b.dataset.mode === 'auto') autoActions.push(b.dataset.cat);
        else confirmActions.push(b.dataset.cat);
      });
      const defSel = document.getElementById('def-' + jid);
      const permissions = {
        acceptCommands: true, autoActions, confirmActions,
        defaultMode: defSel ? defSel.value : 'confirm'
      };
      try {
        await fetch('/api/whitelist/permissions', {
          method: 'PUT', headers: jsonHeaders(),
          body: JSON.stringify({ jid, permissions })
        });
      } catch {}
    }

    // ── Slack workspace management ──
    async function addSlackWorkspace() {
      const id = document.getElementById('slack-id')?.value?.trim();
      const teamName = document.getElementById('slack-team')?.value?.trim();
      const clientId = document.getElementById('slack-client-id')?.value?.trim();
      const clientSecret = document.getElementById('slack-client-secret')?.value?.trim();
      if (!id || !teamName || !clientId || !clientSecret) return;
      try {
        await fetch('/api/slack/workspaces', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ id, teamName, clientId, clientSecret })
        });
        loadIntegrations();
      } catch {}
    }

    async function removeSlackWorkspace(id) {
      if (!confirm('Remove workspace "' + id + '"?')) return;
      try {
        await fetch('/api/slack/workspaces', {
          method: 'DELETE',
          headers: jsonHeaders(),
          body: JSON.stringify({ id })
        });
        loadIntegrations();
      } catch {}
    }

    // ── Calendar management ──
    async function loadCalendarsForAccount(accountId) {
      const container = document.getElementById('calendar-list-container');
      if (!container) return;
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">Loading calendars...</div>';
      try {
        const res = await fetch('/api/calendar/calendars?accountId=' + encodeURIComponent(accountId), { headers: authHeaders() });
        if (!res.ok) { container.innerHTML = '<div style="color:var(--red);font-size:13px;padding:8px 0">Failed to load calendars</div>'; return; }
        const data = await res.json();
        const calendars = data.calendars || [];
        if (!calendars.length) { container.innerHTML = '<div style="color:var(--text-ghost);font-size:13px;padding:8px 0">No calendars found</div>'; return; }

        // Load current config to show existing tags
        const cfgRes = await fetch('/api/calendar/config', { headers: authHeaders() });
        const cfg = cfgRes.ok ? await cfgRes.json() : { calendars: [] };
        const tagMap = {};
        for (const c of (cfg.calendars || [])) { tagMap[c.id] = c.tag; }

        var html = '<h4 style="margin:12px 0 8px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:1px">Available Calendars</h4>';
        for (const cal of calendars) {
          var currentTag = tagMap[cal.id] || '';
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.03)">';
          html += '<span style="font-size:13px;color:var(--text);flex:1">' + esc(cal.name) + '</span>';
          html += '<select onchange="tagCalendar(\'' + esc(cal.id) + '\',\'' + esc(cal.name) + '\',this.value)" style="padding:4px 8px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:11px;font-family:var(--mono)">';
          html += '<option value=""' + (!currentTag ? ' selected' : '') + '>untagged</option>';
          html += '<option value="private"' + (currentTag === 'private' ? ' selected' : '') + '>private</option>';
          html += '<option value="work"' + (currentTag === 'work' ? ' selected' : '') + '>work</option>';
          html += '</select>';
          html += '</div>';
        }
        container.innerHTML = html;
      } catch(e) {
        container.innerHTML = '<div style="color:var(--red);font-size:13px;padding:8px 0">Error: ' + esc(e.message) + '</div>';
      }
    }

    async function tagCalendar(calendarId, name, tag) {
      try {
        // Load current config, update the entry, save back
        const cfgRes = await fetch('/api/calendar/config', { headers: authHeaders() });
        const cfg = cfgRes.ok ? await cfgRes.json() : { calendars: [] };
        const calendars = cfg.calendars || [];
        const idx = calendars.findIndex(function(c) { return c.id === calendarId; });
        const entry = { id: calendarId, name: name, tag: tag || null };
        if (idx >= 0) { calendars[idx] = entry; } else { calendars.push(entry); }
        await fetch('/api/calendar/config', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ calendars: calendars })
        });
        loadIntegrations();
      } catch(e) {
        console.error('Failed to tag calendar:', e);
      }
    }

    // ── Contact sync ──
    async function syncContacts() {
      try {
        const res = await fetch('/api/sync-contacts', {
          method: 'POST',
          headers: authHeaders()
        });
        const d = await res.json();
        if (d.success) loadIntegrations();
      } catch {}
    }

    // ── Chat functions ──
    function updateStats() {
      document.getElementById('st-m').textContent = nMsg;
      document.getElementById('st-t').textContent = totTok.toLocaleString();
      document.getElementById('st-c').textContent = '$' + totCost.toFixed(4);
    }

    async function loadHistory() {
      try {
        const res = await fetch('/api/history', { headers: authHeaders() });
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
        const dur = stats.durationMs >= 1000 ? (stats.durationMs / 1000).toFixed(1) + 's' : stats.durationMs + 'ms';
        h += '<span>' + dur + '</span>';
        h += '<span>' + (stats.inputTokens + stats.outputTokens).toLocaleString() + ' tok</span>';
        h += '<span>$' + stats.totalCostUsd.toFixed(4) + '</span>';
        if (stats.numTurns > 1) h += '<span>' + stats.numTurns + ' turns</span>';
        totTok += (stats.inputTokens || 0) + (stats.outputTokens || 0);
        totCost += stats.totalCostUsd || 0;
        nMsg++;
        updateStats();
      }
      if (source === 'whatsapp') h += '<span class="src-wa">WhatsApp</span>';
      if (ts) h += '<span>' + fmtTime(ts) + '</span>';
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
          headers: jsonHeaders(),
          body: JSON.stringify({ message: text }) });
        if (res.status === 401) { ag.remove(); addGroup('error', 'Session expired'); doLogout(); return; }

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
                ab.innerHTML = full ? marked.parse(full) : '<em style="color:var(--text-ghost)">No response</em>';
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

    // ── AI Providers Section ──
    async function loadProviders() {
      try {
        const [providersRes, subAgentsRes] = await Promise.all([
          fetch('/api/providers', { headers: authHeaders() }),
          fetch('/api/sub-agents', { headers: authHeaders() }),
        ]);
        if (providersRes.status === 401) { resetAuth(); return; }
        const providers = await providersRes.json();
        const subAgents = await subAgentsRes.json();
        renderProviders(providers, subAgents);
      } catch(e) {
        document.getElementById('ai-providers-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderProviders(providers, subAgents) {
      let html = '';

      // AI Providers
      html += '<div class="card" style="margin-bottom:16px"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>AI Providers</h2>';
      if (providers.length) {
        for (const a of providers) {
          html += '<div class="intg-card" style="margin-bottom:8px">';
          html += '<div class="intg-header">';
          html += '<h3>' + esc(a.name) + '</h3>';
          html += '<span class="type-badge ' + (a.provider === 'claude' ? 'plan' : a.provider === 'grok' ? 'emotion' : 'fact') + '">' + esc(a.provider) + '</span>';
          if (a.isDefault) html += '<span class="type-badge insight">default</span>';
          html += '</div>';
          html += kv('ID', a.id);
          if (a.config && a.config.model) html += kv('Model', a.config.model);
          html += kv('Created', fmtDate(a.createdAt));
          html += '<div class="btn-row">';
          if (!a.isDefault) html += '<button class="btn" onclick="setProviderDefault(\'' + esc(a.id) + '\')">Set Default</button>';
          html += '<button class="btn" onclick="testProvider(\'' + esc(a.id) + '\')">Test</button>';
          html += '<button class="btn danger" onclick="deleteProviderById(\'' + esc(a.id) + '\')">Delete</button>';
          html += '</div>';
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:10px 0">No providers configured</div>';
      }
      html += '</div>';

      // Sub-agents
      html += '<div class="card"><h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>Sub-Agents</h2>';
      if (subAgents.length) {
        for (const sa of subAgents) {
          const isEnabled = sa.enabled !== false;
          html += '<div class="intg-card" style="margin-bottom:8px;opacity:' + (isEnabled ? '1' : '0.5') + '">';
          html += '<div class="intg-header">';
          html += '<h3>' + esc(sa.name || sa.id) + '</h3>';
          html += '<span class="intg-status ' + (isEnabled ? 'online' : 'offline') + '">' + (isEnabled ? 'Enabled' : 'Disabled') + '</span>';
          html += '</div>';
          if (sa.description) html += '<div style="color:var(--text-dim);font-size:13px;margin-bottom:8px">' + esc(sa.description) + '</div>';
          if (sa.schedule) html += kv('Schedule', sa.schedule);
          if (sa.lastRun) html += kv('Last Run', timeAgo(sa.lastRun));
          if (sa.runCount) html += kv('Run Count', sa.runCount);
          html += '<div class="btn-row">';
          html += '<button class="btn" onclick="toggleSubAgent(\'' + esc(sa.id) + '\')">' + (isEnabled ? 'Disable' : 'Enable') + '</button>';
          html += '<button class="btn primary" onclick="runSubAgent(\'' + esc(sa.id) + '\')">Run Now</button>';
          html += '</div>';
          html += '</div>';
        }
      } else {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:10px 0">No sub-agents configured</div>';
      }
      html += '</div>';

      document.getElementById('ai-providers-content').innerHTML = html;
    }

    async function setProviderDefault(id) {
      try {
        await fetch('/api/providers/' + id + '/set-default', { method: 'POST', headers: authHeaders() });
        loadProviders();
      } catch {}
    }

    async function testProvider(id) {
      const btn = event.target;
      btn.textContent = 'Testing...'; btn.disabled = true;
      try {
        const res = await fetch('/api/providers/' + id + '/test', { method: 'POST', headers: authHeaders() });
        const d = await res.json();
        btn.textContent = d.success ? 'OK (' + (d.durationMs/1000).toFixed(1) + 's)' : 'Failed';
        btn.style.color = d.success ? 'var(--green)' : 'var(--red)';
        setTimeout(() => { btn.textContent = 'Test'; btn.disabled = false; btn.style.color = ''; }, 3000);
      } catch { btn.textContent = 'Error'; btn.disabled = false; }
    }

    async function deleteProviderById(id) {
      if (!confirm('Delete this provider?')) return;
      try {
        await fetch('/api/providers/' + id, { method: 'DELETE', headers: authHeaders() });
        loadProviders();
      } catch {}
    }

    async function toggleSubAgent(id) {
      try {
        await fetch('/api/sub-agents/' + id + '/toggle', { method: 'POST', headers: authHeaders() });
        loadProviders();
      } catch {}
    }

    async function runSubAgent(id) {
      const btn = event.target;
      btn.textContent = 'Running...'; btn.disabled = true;
      try {
        const res = await fetch('/api/sub-agents/' + id + '/run', { method: 'POST', headers: authHeaders() });
        const d = await res.json();
        btn.textContent = d.success ? 'Done' : 'Failed';
        btn.style.color = d.success ? 'var(--green)' : 'var(--red)';
        setTimeout(() => { btn.textContent = 'Run Now'; btn.disabled = false; btn.style.color = ''; }, 3000);
      } catch { btn.textContent = 'Error'; btn.disabled = false; }
    }

    // ── QR & Reset ──
    function showQr() {
      const url = window.location.origin;
      document.getElementById('qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=ff4d2a&bgcolor=0c0c18&data=' + encodeURIComponent(url);
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
          headers: jsonHeaders(),
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
