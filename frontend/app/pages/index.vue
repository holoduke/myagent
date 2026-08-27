<template>
  <div class="section">
    <div class="home-header">
      <h1><span class="hal-dot"></span>ARIA</h1>
      <div class="version">personal agent</div>
    </div>

    <div class="tile-grid">
      <NuxtLink
        v-for="item in navItems"
        :key="item.id"
        :to="`/${item.id}`"
        class="tile"
      >
        <span class="tile-icon" v-html="item.icon"></span>
        <span class="tile-label">{{ item.label }}</span>
        <span class="tile-desc">{{ item.desc }}</span>
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' })

const navItems = [
  // Core
  { id: 'overview', label: 'Overview', desc: 'System status & brain activity', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' },
  { id: 'chat', label: 'Chat', desc: 'Talk to ARIA directly', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' },
  // Intelligence
  { id: 'memory', label: 'Memory', desc: 'Associative memory graph explorer', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>' },
  { id: 'brain', label: 'Brain', desc: 'Goals, signals & think cycle', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>' },
  // Messaging
  { id: 'directives', label: 'Directives', desc: 'Reply rules, requests & contacts', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>' },
  { id: 'handlers', label: 'Handlers', desc: 'Message filter pipelines', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>' },
  // Configuration
  { id: 'agents', label: 'AI Providers', desc: 'LLM provider configuration', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/><circle cx="12" cy="9" r="2.5"/></svg>' },
  { id: 'sub-agents', label: 'Task Agents', desc: 'Scheduled autonomous tasks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><circle cx="8" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/><path d="M10 10h4"/></svg>' },
  { id: 'skills', label: 'Skills', desc: 'Reusable prompt templates', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' },
  { id: 'integrations', label: 'Integrations', desc: 'WhatsApp, Gmail, Calendar & more', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>' },
  { id: 'security', label: 'Security', desc: 'Trust sources & owner JIDs', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' },
  { id: 'settings', label: 'Settings', desc: 'Character, detection & brain config', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
  // Monitoring
  { id: 'audit', label: 'Audit Log', desc: 'Action history & events', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="12" y2="18"/></svg>' },
  { id: 'backups', label: 'Backups', desc: 'Memory snapshots & restore', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>' },
]
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

.home-header {
  text-align: center;
  margin-bottom: 32px;
  padding-top: 16px;
}
.home-header h1 {
  font-family: var(--mono);
  font-size: 28px;
  color: var(--accent);
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
  animation: breathe 3s ease-in-out infinite;
}
.home-header .version {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--mono);
  letter-spacing: 1px;
  margin-top: 6px;
}

.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.tile {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: all .2s;
  text-decoration: none;
}
.tile:hover {
  border-color: var(--border-glow);
  background: var(--bg-surface);
  box-shadow: var(--glow-card);
  transform: translateY(-1px);
}
.tile-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: rgba(139,92,246,0.08);
  border: 1px solid rgba(139,92,246,0.12);
  color: var(--accent);
}
.tile-icon :deep(svg) {
  width: 20px;
  height: 20px;
}
.tile-label {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.5px;
}
.tile-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .tile-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .home-header {
    margin-bottom: 20px;
    padding-top: 8px;
  }
  .home-header h1 {
    font-size: 22px;
  }
}
</style>
