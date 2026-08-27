<template>
  <div class="mobile-nav">
    <div class="mobile-nav-inner">
      <NuxtLink
        v-for="item in navItems"
        :key="item.id"
        :to="item.to"
        class="mob-nav-item"
        :class="{ active: route.path === item.to }"
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
  { to: '/', label: 'Home', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>' },
  { to: '/overview', label: 'Overview', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>' },
  { to: '/chat', label: 'Chat', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>' },
  { to: '/brain', label: 'Brain', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>' },
  { to: '/settings', label: 'Settings', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>' },
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
  gap: 3px;
  padding: 6px 10px;
  color: var(--text-muted);
  cursor: pointer;
  border: none;
  background: none;
  font-size: 10px;
  font-weight: 500;
  border-radius: var(--radius-sm);
  transition: all .15s;
  text-decoration: none;
}
.mob-nav-item.active { color: var(--accent-warm); }
.mob-nav-item :deep(svg) { width: 18px; height: 18px; }

@media (max-width: 768px) {
  .mobile-nav { display: block; }
}
</style>
