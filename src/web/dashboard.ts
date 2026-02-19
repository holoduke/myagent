import { getStyles } from "./styles.js";

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>` },
  { id: "chat", label: "Chat", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>` },
  { id: "memory", label: "Memory", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>` },
  { id: "integrations", label: "Integrations", icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>` },
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

      <!-- Integrations Section -->
      <div class="section" id="section-integrations">
        <div class="section-header">Integrations</div>
        <div id="integrations-content">
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
      const valid = ['overview','chat','memory','integrations','settings'];
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
      else if (section === 'integrations') loadIntegrations();
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
    function renderNode(n, pinned, ts) {
      let h = '<div class="node"><div class="node-hdr">';
      h += '<span class="type-badge ' + n.type + '">' + n.type + '</span>';
      if (pinned) h += '<span class="pinned-icon">pinned</span>';
      h += '<span class="str">' + n.strength.toFixed(2);
      h += ' <span class="str-bar"><span class="str-fill" style="width:' + (n.strength * 100) + '%"></span></span>';
      h += '</span>';
      if (n.accessCount) h += '<span class="str" style="margin-left:auto">' + n.accessCount + ' access</span>';
      if (ts) h += '<span class="str" style="margin-left:auto">' + timeAgo(ts) + '</span>';
      h += '</div>';
      h += '<div class="content">' + esc(n.content.slice(0,300)) + (n.content.length > 300 ? '...' : '') + '</div>';
      if (n.tags && n.tags.length) {
        h += '<div class="tags">';
        for (const t of n.tags) h += '<span class="tag">' + esc(t) + '</span>';
        h += '</div>';
      }
      h += '</div>';
      return h;
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

    // ── Integrations Section ──
    async function loadIntegrations() {
      try {
        const [dashRes, schedRes, wlRes] = await Promise.all([
          fetch('/api/dashboard', { headers: authHeaders() }),
          fetch('/api/scheduled', { headers: authHeaders() }),
          fetch('/api/whitelist', { headers: authHeaders() }),
        ]);
        if (dashRes.status === 401) { resetAuth(); return; }
        const dash = await dashRes.json();
        const scheduled = await schedRes.json();
        const whitelist = await wlRes.json();
        renderIntegrations(dash, scheduled, whitelist);
      } catch(e) {
        document.getElementById('integrations-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderIntegrations(dash, scheduled, whitelist) {
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
      html += '<h4 style="margin:16px 0 8px;color:var(--text-muted);font-size:12px;text-transform:uppercase;letter-spacing:1px">Contact Whitelist</h4>';
      if (whitelist.length) {
        for (const c of whitelist) {
          html += '<div class="wl-item">';
          html += '<div><span class="wl-name">' + esc(c.name) + '</span><span class="wl-jid">' + esc(c.jid) + '</span></div>';
          html += '<button class="wl-rm" onclick="removeWhitelist(\'' + esc(c.jid) + '\')">Remove</button>';
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
    async function loadSettings() {
      try {
        const dashRes = await fetch('/api/dashboard', { headers: authHeaders() });
        if (dashRes.status === 401) { resetAuth(); return; }
        const dash = await dashRes.json();
        renderSettings(dash);
      } catch(e) {
        document.getElementById('settings-content').innerHTML =
          '<div class="card"><p style="color:var(--red)">Failed to load: ' + e.message + '</p></div>';
      }
    }

    function renderSettings(dash) {
      const si = dash.selfImprove || {};
      let html = '';

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
      if (!si.pendingTask && !si.lastResult) {
        html += '<div style="color:var(--text-ghost);font-size:13px;padding:10px 0">No self-improvement activity yet</div>';
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
