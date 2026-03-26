<template>
  <div class="mobile-nav">
    <div class="mobile-nav-inner">
      <NuxtLink
        v-for="item in navItems"
        :key="item.id"
        :to="`/${item.id}`"
        class="mob-nav-item"
        :class="{ active: route.path === `/${item.id}` }"
      >
        <span v-html="item.icon"></span>
        <span>{{ item.label }}</span>
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()

const navItems = [
  { id: 'overview', label: 'Overview', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' },
  { id: 'chat', label: 'Chat', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' },
  { id: 'memory', label: 'Memory', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>' },
  { id: 'brain', label: 'Brain', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>' },
  { id: 'integrations', label: 'Integ.', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>' },
  { id: 'directives', label: 'Directives', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>' },
  { id: 'handlers', label: 'Handlers', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>' },
  { id: 'agents', label: 'Agents', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/></svg>' },
  { id: 'sub-agents', label: 'Tasks', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><circle cx="8" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/><path d="M10 10h4"/></svg>' },
  { id: 'settings', label: 'Settings', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
]
</script>

<style scoped>
.mobile-nav {
  display: none;
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  padding: 6px 0 max(6px, env(safe-area-inset-bottom));
  flex-shrink: 0;
  z-index: 20;
}
.mobile-nav-inner {
  display: flex;
  justify-content: space-around;
}
.mob-nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  color: var(--text-muted);
  cursor: pointer;
  border: none;
  background: none;
  font-size: 9px;
  font-family: var(--mono);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  transition: all .15s;
  text-decoration: none;
}
.mob-nav-item.active { color: var(--accent); }
.mob-nav-item :deep(svg) { width: 18px; height: 18px; }

@media (max-width: 768px) {
  .mobile-nav { display: block; }
}
</style>
