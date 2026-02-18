<template>
  <div class="section">
    <LayoutSectionHeader>Memory Explorer</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="data?.graph">
      <!-- Graph Statistics -->
      <UiCard v-if="g.byType" title="Graph Statistics" :icon="icons.graph" style="margin-bottom:16px">
        <div class="stat-grid">
          <UiStatCard :value="g.nodeCount || 0" label="Nodes" />
          <UiStatCard :value="g.edgeCount || 0" label="Edges" />
          <UiStatCard :value="(g.avgStrength || 0).toFixed(3)" label="Avg Str" />
          <UiStatCard :value="(g.pinnedNodes || []).length" label="Pinned" />
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
          <span v-for="(count, type) in g.byType" :key="type" class="type-badge" :class="type">
            {{ type }}: {{ count }}
          </span>
        </div>
      </UiCard>

      <!-- Core Directives -->
      <UiCard v-if="g.pinnedNodes?.length" title="Core Directives" :icon="icons.pin" style="margin-bottom:16px">
        <MemoryMemoryNode v-for="n in g.pinnedNodes" :key="n.id" :node="n" :pinned="true" />
      </UiCard>

      <!-- Strongest Memories -->
      <UiCard v-if="g.strongestNodes?.length" title="Strongest Memories" :icon="icons.star" style="margin-bottom:16px">
        <MemoryMemoryNode v-for="n in g.strongestNodes.slice(0, 10)" :key="n.id" :node="n" />
      </UiCard>

      <!-- Recent Memories -->
      <UiCard v-if="g.recentNodes?.length" title="Recent Memories" :icon="icons.clock" style="margin-bottom:16px">
        <MemoryMemoryNode v-for="n in g.recentNodes" :key="n.id" :node="n" :show-time="true" />
      </UiCard>

      <div v-if="!g.pinnedNodes?.length && !g.strongestNodes?.length && !g.recentNodes?.length" style="color:var(--text-ghost);text-align:center;padding:40px">
        No memories yet
      </div>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { AriaStatus } from '~/types/aria'

const { api } = useApi()
const data = ref<AriaStatus | null>(null)
const error = ref('')

const g = computed(() => data.value?.graph || {} as Record<string, unknown>)

const icons = {
  graph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 01-1.11-1.65l-.54-4.81A1 1 0 018.34 3h7.32a1 1 0 01.99 1.1l-.54 5.01A2 2 0 0115 10.76L12 14l-3-3.24z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
}

onMounted(async () => {
  try {
    data.value = await api<AriaStatus>('/api/aria/status')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
})
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
}
</style>
