export function getStyles(): string {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Space+Mono:wght@400;700&display=swap');

    *{margin:0;padding:0;box-sizing:border-box}
    html{height:100%;-webkit-text-size-adjust:100%;color-scheme:dark}

    :root {
      --bg: #060610;
      --bg-card: #0c0c18;
      --bg-surface: #10101e;
      --bg-elevated: #141428;
      --border: #1a1a30;
      --border-glow: #252545;
      --accent: #ff4d2a;
      --accent-warm: #ff8c42;
      --accent-gradient: linear-gradient(135deg, #ff4d2a, #ff8c42);
      --cyan: #00e5ff;
      --cyan-dim: #007a8a;
      --green: #22c55e;
      --yellow: #eab308;
      --red: #ef4444;
      --text: #d4d4d8;
      --text-dim: #8e8e96;
      --text-muted: #8585a0;
      --text-ghost: #6a6a82;
      --mono: 'JetBrains Mono', 'Space Mono', monospace;
      --sans: 'Inter', system-ui, sans-serif;
      --glow-accent: 0 0 10px rgba(255,77,42,0.5);
      --glow-cyan: 0 0 10px rgba(0,229,255,0.3);
      --glow-card: 0 0 15px rgba(0,229,255,0.05);
      --sidebar-w: 200px;
    }

    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      height: 100dvh;
      overflow: hidden;
    }

    /* Scanline overlay */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0,229,255,0.01) 2px,
        rgba(0,229,255,0.01) 4px
      );
      pointer-events: none;
      z-index: 9999;
    }

    /* ── Login Screen ── */
    #login {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100dvh;
      flex-direction: column;
      background: radial-gradient(ellipse at 50% 30%, #0f0a18 0%, var(--bg) 70%);
    }

    .login-ring {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      border: 2px solid var(--accent);
      box-shadow: var(--glow-accent), inset 0 0 20px rgba(255,77,42,0.15);
      margin-bottom: 24px;
      animation: pulse-ring 3s ease-in-out infinite;
      position: relative;
    }
    .login-ring::after {
      content: '';
      position: absolute;
      inset: 8px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,77,42,0.3) 0%, transparent 70%);
    }

    @keyframes pulse-ring {
      0%, 100% { box-shadow: 0 0 10px rgba(255,77,42,0.5), inset 0 0 20px rgba(255,77,42,0.15); transform: scale(1); }
      50% { box-shadow: 0 0 25px rgba(255,77,42,0.7), inset 0 0 30px rgba(255,77,42,0.25); transform: scale(1.02); }
    }

    .login-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 36px;
      width: min(380px, 90vw);
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,.5), var(--glow-card);
    }
    .login-card h1 {
      font-family: var(--mono);
      font-size: 24px;
      font-weight: 700;
      color: var(--accent);
      text-shadow: var(--glow-accent);
      letter-spacing: 6px;
      text-transform: uppercase;
    }
    .login-card .subtitle {
      color: var(--text-muted);
      font-family: var(--mono);
      font-size: 11px;
      margin: 8px 0 28px;
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    /* ── Unified input/textarea base ── */
    input[type="text"],
    input[type="password"],
    input[type="email"],
    input[type="url"],
    input[type="search"],
    textarea {
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 13px;
      font-family: var(--mono);
      outline: none;
      transition: border-color .2s, box-shadow .2s;
    }
    input[type="text"]:focus,
    input[type="password"]:focus,
    input[type="email"]:focus,
    input[type="url"]:focus,
    input[type="search"]:focus,
    textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(255,77,42,0.1);
    }
    input::placeholder,
    textarea::placeholder {
      color: var(--text-ghost);
    }

    .login-card input {
      width: 100%;
      font-size: 14px;
    }

    /* Override browser autofill white backgrounds */
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    textarea:-webkit-autofill {
      -webkit-text-fill-color: var(--text);
      -webkit-box-shadow: 0 0 0 1000px var(--bg) inset;
      border-color: var(--border) !important;
      transition: background-color 5000s ease-in-out 0s;
    }
    .login-card button {
      width: 100%;
      padding: 13px;
      border-radius: 10px;
      border: 1px solid var(--accent);
      margin-top: 16px;
      background: transparent;
      color: var(--accent);
      font-size: 13px;
      font-weight: 600;
      font-family: var(--mono);
      letter-spacing: 2px;
      text-transform: uppercase;
      cursor: pointer;
      transition: all .2s;
    }
    .login-card button:hover {
      background: rgba(255,77,42,0.1);
      box-shadow: var(--glow-accent);
    }
    .login-err { color: var(--red); font-size: 13px; min-height: 18px; margin-top: 12px; font-family: var(--mono); }

    /* ── App Layout ── */
    #app { display: none; height: 100dvh; }
    #app.visible { display: flex; }

    /* ── Sidebar ── */
    .sidebar {
      width: var(--sidebar-w);
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      box-shadow: 1px 0 10px rgba(0,229,255,0.03);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      z-index: 20;
    }
    .sidebar-logo {
      padding: 20px 16px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-logo h1 {
      font-family: var(--mono);
      font-size: 18px;
      color: var(--accent);
      text-shadow: var(--glow-accent);
      letter-spacing: 4px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .sidebar-logo .hal-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px rgba(255,77,42,0.6);
      animation: breathe 3s ease-in-out infinite;
    }
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 8px rgba(255,77,42,0.6); opacity: 1; }
      50% { box-shadow: 0 0 16px rgba(255,77,42,0.9); opacity: 0.8; }
    }
    .sidebar-logo .version {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--mono);
      letter-spacing: 1px;
      margin-top: 4px;
    }

    .sidebar-nav {
      flex: 1;
      padding: 8px 0;
      overflow-y: auto;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 13px;
      font-family: var(--sans);
      font-weight: 500;
      border-left: 3px solid transparent;
      transition: all .15s;
      text-decoration: none;
    }
    .nav-item:hover {
      color: var(--text);
      background: rgba(255,255,255,0.02);
    }
    .nav-item.active {
      color: var(--accent);
      border-left-color: var(--accent);
      box-shadow: inset 3px 0 10px rgba(255,77,42,0.15);
      background: rgba(255,77,42,0.05);
    }
    .nav-item svg { width: 16px; height: 16px; flex-shrink: 0; opacity: 0.7; }
    .nav-item.active svg { opacity: 1; }

    .sidebar-footer {
      padding: 12px 16px;
      border-top: 1px solid var(--border);
    }
    .sidebar-footer .logout-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      color: var(--text-muted);
      font-size: 12px;
      font-family: var(--mono);
      cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: transparent;
      width: 100%;
      transition: all .15s;
    }
    .sidebar-footer .logout-btn:hover {
      color: var(--red);
      border-color: var(--red);
    }
    .sidebar-footer .logout-btn svg { width: 14px; height: 14px; }

    /* ── Main Content Area ── */
    .main-content {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* ── Section Container ── */
    .section {
      display: none;
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      animation: fadeSection .2s ease;
    }
    .section.active { display: flex; flex-direction: column; }
    @keyframes fadeSection {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .section-header {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
      letter-spacing: 3px;
      text-transform: uppercase;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    /* ── Cards ── */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      box-shadow: var(--glow-card);
    }
    .card h2 {
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      color: var(--accent-warm);
      letter-spacing: 2px;
      text-transform: uppercase;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card h2 svg { width: 14px; height: 14px; opacity: 0.7; }

    .card-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
      margin-bottom: 16px;
    }
    .card-grid .full { grid-column: 1 / -1; }

    /* ── Key-Value rows ── */
    .kv {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 0;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      font-size: 13px;
    }
    .kv:last-child { border-bottom: none; }
    .kv .k { color: var(--text-dim); }
    .kv .v {
      color: var(--cyan);
      font-family: var(--mono);
      font-size: 12px;
      text-shadow: 0 0 6px rgba(0,229,255,0.15);
    }
    .kv .v.good { color: var(--green); text-shadow: 0 0 6px rgba(34,197,94,0.2); }
    .kv .v.warn { color: var(--yellow); text-shadow: 0 0 6px rgba(234,179,8,0.2); }
    .kv .v.bad { color: var(--red); text-shadow: 0 0 6px rgba(239,68,68,0.2); }

    /* ── Stat grid ── */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    .stat {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      text-align: center;
    }
    .stat .num {
      font-size: 22px;
      font-weight: 700;
      color: var(--cyan);
      font-family: var(--mono);
      text-shadow: var(--glow-cyan);
    }
    .stat .label {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-family: var(--mono);
    }

    /* ── Status dot (pulsing) ── */
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      position: relative;
    }
    .status-dot::after {
      content: '';
      position: absolute;
      inset: -3px;
      border-radius: 50%;
      animation: status-pulse 2s ease-in-out infinite;
    }
    .status-dot.ok { background: var(--green); }
    .status-dot.ok::after { border: 1px solid var(--green); }
    .status-dot.warn { background: var(--yellow); }
    .status-dot.warn::after { border: 1px solid var(--yellow); }
    .status-dot.err { background: var(--red); }
    .status-dot.err::after { border: 1px solid var(--red); }
    @keyframes status-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.3; transform: scale(1.5); }
    }

    /* ── Type badges ── */
    .type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 500;
      font-family: var(--mono);
      letter-spacing: 0.5px;
    }
    .type-badge.person { background: #0a1a2e; color: #4d9cd4; border: 1px solid #1a3050; }
    .type-badge.event { background: #1a0a2e; color: #9d6ad4; border: 1px solid #2a1a40; }
    .type-badge.insight { background: #0a2e1a; color: #4dd49c; border: 1px solid #1a4030; }
    .type-badge.fact { background: #2e2a0a; color: #d4c44d; border: 1px solid #40381a; }
    .type-badge.emotion { background: #2e0a1a; color: #d44d7a; border: 1px solid #401a2a; }
    .type-badge.plan { background: #0a1a2e; color: #4db4d4; border: 1px solid #1a3040; }
    .type-badge.meta { background: #1a1a1a; color: #8a8a8a; border: 1px solid #2a2a2a; }

    /* ── Memory nodes ── */
    .node {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 14px;
      margin-bottom: 8px;
      font-size: 13px;
      line-height: 1.5;
    }
    .node .node-hdr {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .node .str {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--text-muted);
    }
    .node .str-bar {
      width: 50px;
      height: 4px;
      background: var(--bg-elevated);
      border-radius: 2px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-left: 4px;
    }
    .node .str-fill {
      height: 100%;
      border-radius: 2px;
      background: linear-gradient(90deg, var(--red), var(--yellow), var(--green));
      box-shadow: 0 0 4px rgba(0,229,255,0.2);
    }
    .node .content { color: var(--text-dim); }
    .node .tags { margin-top: 6px; }
    .node .tag {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-family: var(--mono);
      background: var(--bg-elevated);
      color: var(--text-muted);
      margin-right: 4px;
      margin-bottom: 2px;
    }
    .node .pinned-icon {
      color: var(--accent-warm);
      font-size: 10px;
      font-family: var(--mono);
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    /* ── Working memory fields ── */
    .wm-field {
      background: var(--bg);
      border-radius: 10px;
      padding: 10px 14px;
      margin-bottom: 8px;
      border: 1px solid var(--border);
    }
    .wm-field .wm-label {
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      font-family: var(--mono);
      margin-bottom: 4px;
    }
    .wm-field .wm-val { font-size: 13px; color: var(--text-dim); line-height: 1.5; }

    /* ── Self-improve ── */
    .si-task {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 8px;
    }
    .si-task.pending { border-color: #2a2a1a; }
    .si-task.success { border-color: #1a2a1a; }
    .si-task.failed { border-color: #2a1a1a; }
    .si-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; font-family: var(--mono); }
    .si-val { font-size: 13px; color: var(--text-dim); margin-top: 2px; }

    /* ── Integration cards ── */
    .intg-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 12px;
    }
    .intg-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .intg-header h3 {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--text);
      letter-spacing: 1px;
      flex: 1;
    }
    .intg-status {
      font-size: 11px;
      font-family: var(--mono);
      padding: 3px 10px;
      border-radius: 6px;
    }
    .intg-status.online { color: var(--green); background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); }
    .intg-status.offline { color: var(--red); background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); }
    .intg-status.pending { color: var(--yellow); background: rgba(234,179,8,0.1); border: 1px solid rgba(234,179,8,0.2); }

    /* ── Buttons ── */
    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12px;
      font-family: var(--mono);
      font-weight: 500;
      cursor: pointer;
      transition: all .15s;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-dim);
      letter-spacing: 0.5px;
    }
    .btn:hover { color: var(--text); background: var(--bg-elevated); }
    .btn.primary {
      border-color: var(--accent);
      color: var(--accent);
    }
    .btn.primary:hover { background: rgba(255,77,42,0.1); box-shadow: var(--glow-accent); }
    .btn.danger { border-color: var(--red); color: var(--red); }
    .btn.danger:hover { background: rgba(239,68,68,0.1); }
    .btn-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }

    /* ── Whitelist ── */
    .wl-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      font-size: 13px;
    }
    .wl-item:last-child { border-bottom: none; }
    .wl-item .wl-name { color: var(--text); font-weight: 500; }
    .wl-item .wl-jid { color: var(--text-muted); font-family: var(--mono); font-size: 11px; margin-left: 8px; }
    .wl-item .wl-rm {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-family: var(--mono);
      cursor: pointer;
      transition: all .15s;
    }
    .wl-item .wl-rm:hover { border-color: var(--red); color: var(--red); }

    .wl-add-form {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    .wl-add-form input {
      flex: 1;
    }

    /* ── Scheduled messages ── */
    .sched-item {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 8px;
    }
    .sched-item .sched-target { font-family: var(--mono); font-size: 11px; color: var(--cyan); }
    .sched-item .sched-time { font-size: 11px; color: var(--text-muted); font-family: var(--mono); }
    .sched-item .sched-msg { font-size: 13px; color: var(--text-dim); margin-top: 4px; }

    /* ── Chat Section ── */
    #section-chat {
      padding: 0;
      display: none;
    }
    #section-chat.active {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }

    .chat-header {
      padding: 10px 16px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .chat-stats {
      display: flex;
      gap: 14px;
      font-size: 11px;
      color: var(--text-ghost);
      font-variant-numeric: tabular-nums;
      font-family: var(--mono);
    }
    .chat-stats .cv { color: var(--text-muted); font-weight: 500; }
    .chat-actions { display: flex; gap: 6px; }
    .chat-btn {
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 11px;
      font-family: var(--mono);
      transition: all .15s;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .chat-btn:hover { color: var(--text); border-color: var(--border-glow); }
    .chat-btn svg { width: 13px; height: 13px; }

    /* Messages area */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      overscroll-behavior: contain;
    }
    #messages::-webkit-scrollbar { width: 4px; }
    #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--text-ghost);
      gap: 12px;
      padding: 40px;
      text-align: center;
      min-height: 200px;
    }
    .empty-state svg { width: 48px; height: 48px; opacity: .2; }
    .empty-state p { font-size: 14px; color: var(--text-muted); }
    .empty-state small { font-size: 12px; color: var(--text-ghost); }

    /* Message groups */
    .mg { display: flex; flex-direction: column; gap: 2px; max-width: min(85%,760px); animation: fadeIn .25s ease; }
    .mg.user { align-self: flex-end; align-items: flex-end; }
    .mg.assistant { align-self: flex-start; align-items: flex-start; }
    .mg.system { align-self: center; }
    .mg.error { align-self: center; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    /* Bubbles */
    .bb { padding: 10px 14px; border-radius: 16px; line-height: 1.6; font-size: 14.5px; word-wrap: break-word; overflow-wrap: break-word; }
    .user .bb {
      background: linear-gradient(135deg, rgba(255,77,42,0.12), rgba(255,140,66,0.08));
      border: 1px solid rgba(255,77,42,0.15);
      color: #e8c9a0;
      border-bottom-right-radius: 6px;
      white-space: pre-wrap;
    }
    .assistant .bb {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-bottom-left-radius: 6px;
    }
    .error .bb { background: #1a0a0a; border: 1px solid #2a1515; color: #f87171; text-align: center; font-size: 13px; border-radius: 12px; }
    .system .bb { background: none; color: var(--text-ghost); font-size: 12px; padding: 6px 0; }

    /* Meta line */
    .meta { font-size: 10px; color: var(--text-ghost); padding: 2px 4px; display: flex; gap: 8px; font-variant-numeric: tabular-nums; flex-wrap: wrap; align-items: center; }
    .meta .src-wa { color: #25D366; }

    /* ── Markdown in chat ── */
    .bb p { margin: .35em 0; } .bb p:first-child { margin-top: 0; } .bb p:last-child { margin-bottom: 0; }
    .bb code { background: rgba(0,0,0,.45); padding: 1px 5px; border-radius: 4px; font-family: var(--mono); font-size: .84em; }
    .bb pre { background: var(--bg); padding: 0; border-radius: 10px; overflow: hidden; margin: 8px 0; border: 1px solid var(--border); position: relative; }
    .bb pre code { background: none; padding: 14px; font-size: .82em; line-height: 1.55; display: block; overflow-x: auto; }
    .bb pre .copy-btn { position: absolute; top: 6px; right: 6px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: rgba(6,6,16,.9); color: var(--text-muted); cursor: pointer; font-size: 10px; font-family: var(--mono); opacity: 0; transition: opacity .2s; }
    .bb pre:hover .copy-btn { opacity: 1; }
    .bb pre .copy-btn:hover { color: var(--accent); border-color: var(--accent); }
    .bb ul, .bb ol { padding-left: 18px; margin: .35em 0; }
    .bb li { margin: .1em 0; }
    .bb blockquote { border-left: 3px solid var(--accent); padding-left: 12px; margin: 8px 0; color: var(--text-dim); }
    .bb a { color: var(--cyan); text-decoration: none; } .bb a:hover { text-decoration: underline; }
    .bb table { border-collapse: collapse; margin: 8px 0; font-size: .86em; display: block; overflow-x: auto; }
    .bb th, .bb td { border: 1px solid var(--border); padding: 5px 10px; text-align: left; }
    .bb th { background: var(--bg-card); font-weight: 600; }
    .bb strong { color: #e4e4e7; } .bb em { color: var(--text-dim); }
    .bb h1, .bb h2, .bb h3, .bb h4 { color: #e4e4e7; margin: .5em 0 .25em; font-weight: 600; }
    .bb h1 { font-size: 1.15em; } .bb h2 { font-size: 1.05em; } .bb h3 { font-size: 1em; }
    .bb hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
    .bb img { max-width: 100%; border-radius: 8px; margin: 8px 0; }

    /* Cursor + waiting */
    .cur { display: inline-block; width: 6px; height: 15px; background: var(--accent); animation: bk .7s infinite; vertical-align: text-bottom; margin-left: 2px; border-radius: 1px; box-shadow: 0 0 6px rgba(255,77,42,0.4); }
    @keyframes bk { 0%, 40% { opacity: 1; } 50%, 100% { opacity: 0; } }
    .wait { display: flex; align-items: center; gap: 8px; color: var(--text-ghost); font-size: 13px; padding: 4px 0; }
    .spin { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: sp .6s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }

    /* Scroll FAB */
    #scroll-fab {
      position: absolute;
      bottom: 80px;
      right: 16px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-dim);
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 5;
      box-shadow: 0 4px 12px rgba(0,0,0,.4);
      transition: all .2s;
    }
    #scroll-fab:hover { color: var(--accent); border-color: var(--accent); }
    #scroll-fab svg { width: 16px; height: 16px; fill: currentColor; }

    /* Input area */
    #input-area {
      padding: 10px 12px max(10px, env(safe-area-inset-bottom));
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      display: flex;
      gap: 8px;
      flex-shrink: 0;
      align-items: flex-end;
    }
    #msg-input {
      flex: 1;
      font-size: 14px;
      font-family: var(--sans);
      resize: none;
      min-height: 42px;
      max-height: 160px;
      line-height: 1.4;
      border-radius: 12px;
    }
    #send-btn {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      border: 1px solid var(--accent);
      background: transparent;
      color: var(--accent);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all .2s;
      flex-shrink: 0;
    }
    #send-btn:hover { background: rgba(255,77,42,0.1); box-shadow: var(--glow-accent); }
    #send-btn:disabled { opacity: .25; cursor: not-allowed; }
    #send-btn svg { width: 17px; height: 17px; fill: currentColor; }

    /* QR Modal */
    #qr-modal {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 100;
      background: rgba(6,6,16,.85);
      justify-content: center;
      align-items: center;
      backdrop-filter: blur(8px);
    }
    #qr-modal.visible { display: flex; }
    .qr-box {
      background: var(--bg-card);
      border-radius: 16px;
      padding: 32px;
      text-align: center;
      border: 1px solid var(--border);
      width: min(320px, 85vw);
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    .qr-box h2 { color: var(--accent-warm); font-family: var(--mono); font-size: 14px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 20px; }
    .qr-box img { border-radius: 12px; width: 200px; height: 200px; }
    .qr-box p { color: var(--text-ghost); font-size: 11px; margin-top: 14px; word-break: break-all; font-family: var(--mono); }
    .qr-box .close-btn {
      margin-top: 16px;
      padding: 8px 24px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--mono);
    }
    .qr-box .close-btn:hover { color: var(--text); border-color: var(--border-glow); }

    /* ── Home Tiles (replaces mobile bottom nav) ── */
    #section-home { display: none; }
    #section-home.active { display: flex; flex-direction: column; }

    .home-header {
      text-align: center;
      padding: 32px 16px 24px;
    }
    .home-header h1 {
      font-family: var(--mono);
      font-size: 28px;
      color: var(--accent);
      text-shadow: var(--glow-accent);
      letter-spacing: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .home-header .hal-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 8px rgba(255,77,42,0.6);
      animation: breathe 3s ease-in-out infinite;
    }
    .home-version {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--mono);
      letter-spacing: 1px;
      margin-top: 6px;
    }

    .home-tiles {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      padding: 0 16px;
      max-width: 600px;
      margin: 0 auto;
      width: 100%;
    }
    .home-tile {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      text-decoration: none;
      color: var(--text);
      transition: all .15s;
      -webkit-tap-highlight-color: transparent;
    }
    .home-tile:hover, .home-tile:active {
      border-color: var(--accent);
      background: rgba(255,77,42,0.04);
      box-shadow: 0 0 20px rgba(255,77,42,0.08);
    }
    .home-tile-icon {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-surface);
      border-radius: 10px;
      flex-shrink: 0;
      border: 1px solid var(--border);
    }
    .home-tile-icon svg { width: 20px; height: 20px; color: var(--accent); }
    .home-tile-text { flex: 1; min-width: 0; }
    .home-tile-label {
      font-family: var(--mono);
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
      letter-spacing: 0.5px;
    }
    .home-tile-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .home-tile-url {
      font-family: var(--mono);
      font-size: 10px;
      color: var(--text-ghost);
      flex-shrink: 0;
    }
    .home-footer {
      padding: 24px 16px;
      text-align: center;
    }
    .logout-btn-mobile {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      color: var(--text-muted);
      font-size: 12px;
      font-family: var(--mono);
      cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: transparent;
      transition: all .15s;
    }
    .logout-btn-mobile:hover { color: var(--red); border-color: var(--red); }
    .logout-btn-mobile svg { width: 14px; height: 14px; }

    /* ── Back Button (mobile, in section headers) ── */
    .back-btn {
      display: none;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      flex-shrink: 0;
      margin-right: 10px;
      transition: all .15s;
      -webkit-tap-highlight-color: transparent;
    }
    .back-btn:hover { color: var(--accent); border-color: var(--accent); }
    .back-btn svg { width: 16px; height: 16px; }

    /* ── Expandable memory nodes ── */
    .node .content.truncated { cursor: pointer; }
    .node .content.truncated:hover { color: var(--text); }
    .node .expand-hint {
      color: var(--accent);
      font-size: 11px;
      font-family: var(--mono);
      cursor: pointer;
      margin-top: 4px;
      display: inline-block;
    }
    .node .expand-hint:hover { text-decoration: underline; }

    /* Desktop: hide home tiles, hide back buttons */
    @media (min-width: 769px) {
      #section-home { display: none !important; }
      .back-btn { display: none !important; }
      .logout-btn-mobile { display: none; }
    }

    @media (max-width: 768px) {
      #app.visible { flex-direction: column; }
      .sidebar { display: none; }
      .back-btn { display: flex; }
      .section-header { display: flex; align-items: center; }
      .chat-header .back-btn { display: flex; }
      .section { padding: 16px 12px; }
      .card-grid { grid-template-columns: 1fr; }
      .stat-grid { grid-template-columns: repeat(2, 1fr); }
      .mg { max-width: 94%; }
      #messages { padding: 12px 8px; }
      .chat-btn span { display: none; }
      .wl-add-form { flex-direction: column; }
    }
  `;
}
