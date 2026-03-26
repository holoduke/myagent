<template>
  <div class="sidebar">
    <div class="sidebar-logo">
      <h1><span class="hal-dot"></span>ARIA</h1>
      <div class="version">v1.0 mainframe</div>
    </div>
    <div class="sidebar-nav">
      <NuxtLink
        v-for="item in navItems"
        :key="item.id"
        :to="`/${item.id}`"
        class="nav-item"
        :class="{ active: route.path === `/${item.id}` }"
      >
        <span v-html="item.icon"></span>
        <span>{{ item.label }}</span>
      </NuxtLink>
    </div>
    <div class="sidebar-footer">
      <button class="logout-btn" @click="logout()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Logout
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const { logout } = useAuth()

const navItems = [
  { id: 'overview', label: 'Overview', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' },
  { id: 'chat', label: 'Chat', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' },
  { id: 'memory', label: 'Memory', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>' },
  { id: 'brain', label: 'Brain', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>' },
  { id: 'integrations', label: 'Integrations', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>' },
  { id: 'directives', label: 'Directives', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>' },
  { id: 'handlers', label: 'Handlers', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>' },
  { id: 'reply-agent', label: 'Reply Agent', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>' },
  { id: 'agents', label: 'Agents', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>' },
  { id: 'sub-agents', label: 'Task Agents', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><circle cx="8" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/><path d="M10 10h4"/></svg>' },
  { id: 'audit', label: 'Audit', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>' },
  { id: 'security', label: 'Security', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' },
  { id: 'settings', label: 'Settings', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
]
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  background: var(--bg-card);
  border-right: 1px solid var(--border);
  box-shadow: 1px 0 10px rgba(168,85,247,0.03);
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
  box-shadow: 0 0 8px rgba(168,85,247,0.6);
  animation: breathe 3s ease-in-out infinite;
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
  font-size: 14px;
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
  box-shadow: inset 3px 0 10px rgba(168,85,247,0.15);
  background: rgba(168,85,247,0.05);
}
.nav-item :deep(svg) { width: 16px; height: 16px; flex-shrink: 0; opacity: 0.7; }
.nav-item.active :deep(svg) { opacity: 1; }
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
.sidebar-footer .logout-btn:hover { color: var(--red); border-color: var(--red); }
.sidebar-footer .logout-btn svg { width: 14px; height: 14px; }

@media (max-width: 768px) {
  .sidebar { display: none; }
}
</style>
