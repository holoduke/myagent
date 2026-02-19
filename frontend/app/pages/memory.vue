<template>
  <div class="section">
    <LayoutSectionHeader>Memory Explorer</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <div v-if="renderError" class="card" style="margin-bottom:16px">
      <p style="color:var(--red)">Render error: {{ renderError }}</p>
    </div>

    <template v-if="data && !error">
      <!-- Working Memory -->
      <UiCard v-if="wm" title="Working Memory" :icon="icons.brain" style="margin-bottom:16px">
        <div class="wm-grid">
          <div class="wm-item">
            <span class="wm-label">Mood</span>
            <span class="wm-value">{{ wm.mood || 'neutral' }}</span>
          </div>
          <div class="wm-item wm-wide">
            <span class="wm-label">Current Context</span>
            <span class="wm-value">{{ wm.currentContext || 'None' }}</span>
          </div>
        </div>
        <div v-if="wm.shortTermTracking?.length" class="wm-tracking">
          <span class="wm-label">Tracking</span>
          <div class="wm-tags">
            <span v-for="(item, i) in wm.shortTermTracking" :key="i" class="tag">{{ item }}</span>
          </div>
        </div>
        <div v-if="wm.activatedNodeIds?.length" class="wm-activated">
          <span class="wm-label">{{ wm.activatedNodeIds.length }} activated nodes</span>
        </div>
        <div v-if="wm.lastUpdated" class="wm-updated">
          Updated {{ timeAgo(wm.lastUpdated) }}
        </div>
      </UiCard>

      <!-- Graph Statistics -->
      <UiCard title="Graph Statistics" :icon="icons.graph" style="margin-bottom:16px">
        <div class="stat-grid">
          <UiStatCard :value="g.nodeCount || 0" label="Nodes" />
          <UiStatCard :value="g.edgeCount || 0" label="Edges" />
          <UiStatCard :value="(g.avgStrength || 0).toFixed(3)" label="Avg Strength" />
          <UiStatCard :value="pinnedList.length" label="Pinned" />
        </div>
        <div v-if="g.byType && Object.keys(g.byType).length" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
          <span v-for="(count, type) in g.byType" :key="type" class="type-badge" :class="type">
            {{ type }}: {{ count }}
          </span>
        </div>
      </UiCard>

      <!-- Brain Activity -->
      <UiCard v-if="bs" title="Brain Activity" :icon="icons.activity" style="margin-bottom:16px">
        <div class="kv-grid">
          <div class="kv"><span class="k">Total Thinks</span><span class="v">{{ bs.totalThinks }}</span></div>
          <div class="kv"><span class="k">Total Cost</span><span class="v">${{ bs.totalCost?.toFixed(4) }}</span></div>
          <div class="kv"><span class="k">Messages Today</span><span class="v">{{ bs.messagesToday }}</span></div>
          <div class="kv"><span class="k">Failures</span><span class="v">{{ bs.consecutiveFailures }}</span></div>
          <div class="kv"><span class="k">Self-Mod Pending</span><span class="v">{{ bs.pendingSelfMod ? 'Yes' : 'No' }}</span></div>
          <div class="kv"><span class="k">Last Think</span><span class="v">{{ bs.lastThinkTick ? timeAgo(bs.lastThinkTick) : 'never' }}</span></div>
        </div>
      </UiCard>

      <!-- Search -->
      <div class="search-bar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input v-model="searchQuery" type="text" placeholder="Search memories by content or tag..." />
        <select v-model="typeFilter" class="type-select">
          <option value="">All types</option>
          <option v-for="t in availableTypes" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>

      <!-- Filtered results -->
      <UiCard v-if="searchQuery || typeFilter" title="Search Results" :icon="icons.search" style="margin-bottom:16px">
        <div v-if="filteredNodes.length" class="node-list">
          <MemoryMemoryNode v-for="n in filteredNodes" :key="n.id" :node="n" :show-time="true" />
        </div>
        <div v-else class="empty-hint">No memories match your search</div>
      </UiCard>

      <!-- Core Directives -->
      <template v-if="!searchQuery && !typeFilter">
        <UiCard v-if="pinnedList.length" title="Core Directives" :icon="icons.pin" style="margin-bottom:16px">
          <div class="node-list">
            <MemoryMemoryNode v-for="n in pinnedList" :key="n.id" :node="n" :pinned="true" />
          </div>
        </UiCard>

        <!-- Strongest Memories -->
        <UiCard v-if="strongList.length" title="Strongest Memories" :icon="icons.star" style="margin-bottom:16px">
          <div class="node-list">
            <MemoryMemoryNode v-for="n in displayedStrongest" :key="n.id" :node="n" />
          </div>
          <button v-if="strongList.length > 10 && !showAllStrongest" class="btn" style="margin-top:8px" @click="showAllStrongest = true">
            Show all {{ strongList.length }} memories
          </button>
        </UiCard>

        <!-- Recent Memories -->
        <UiCard v-if="recentList.length" title="Recent Memories" :icon="icons.clock" style="margin-bottom:16px">
          <div class="node-list">
            <MemoryMemoryNode v-for="n in recentList" :key="n.id" :node="n" :show-time="true" />
          </div>
        </UiCard>

        <!-- Weakest / Decaying Memories -->
        <UiCard v-if="weakList.length" title="Decaying Memories" :icon="icons.fade" style="margin-bottom:16px">
          <p class="card-hint">These memories are fading and may be pruned soon.</p>
          <div class="node-list">
            <MemoryMemoryNode v-for="n in weakList" :key="n.id" :node="n" />
          </div>
        </UiCard>

        <div v-if="!pinnedList.length && !strongList.length && !recentList.length" class="empty-hint" style="padding:40px">
          No memories yet — ARIA will start building memories as she receives observations.
        </div>
      </template>
    </template>

    <div v-if="!data && !error" class="empty-hint" style="padding:40px">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { AriaStatus, GraphNode } from '~/types/aria'

const { api } = useApi()
const { timeAgo } = useTimeAgo()
const data = ref<AriaStatus | null>(null)
const error = ref('')
const renderError = ref('')
const searchQuery = ref('')
const typeFilter = ref('')
const showAllStrongest = ref(false)

onErrorCaptured((err) => {
  renderError.value = err instanceof Error ? err.message : String(err)
  console.error('[memory] Render error:', err)
  return false
})

const g = computed(() => data.value?.graph ?? {} as Partial<AriaStatus['graph']>)
const wm = computed(() => data.value?.workingMemory ?? null)
const bs = computed(() => data.value?.brainState ?? null)

const pinnedList = computed(() => {
  try { return Array.isArray(g.value.pinnedNodes) ? g.value.pinnedNodes : [] }
  catch { return [] }
})
const strongList = computed(() => {
  try { return Array.isArray(g.value.strongestNodes) ? g.value.strongestNodes : [] }
  catch { return [] }
})
const recentList = computed(() => {
  try { return Array.isArray(g.value.recentNodes) ? g.value.recentNodes : [] }
  catch { return [] }
})
const weakList = computed(() => {
  try { return Array.isArray(g.value.weakestNodes) ? g.value.weakestNodes : [] }
  catch { return [] }
})

const allNodes = computed<GraphNode[]>(() => {
  if (!data.value?.graph) return []
  const seen = new Set<string>()
  const nodes: GraphNode[] = []
  for (const list of [pinnedList.value, strongList.value, recentList.value, weakList.value]) {
    for (const n of list) {
      if (n?.id && !seen.has(n.id)) {
        seen.add(n.id)
        nodes.push(n)
      }
    }
  }
  return nodes
})

const availableTypes = computed(() => {
  const types = new Set<string>()
  for (const n of allNodes.value) types.add(n.type)
  return Array.from(types).sort()
})

const filteredNodes = computed(() => {
  let nodes = allNodes.value
  if (typeFilter.value) {
    nodes = nodes.filter(n => n.type === typeFilter.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    nodes = nodes.filter(n =>
      n.content.toLowerCase().includes(q) ||
      n.tags?.some(t => t.toLowerCase().includes(q))
    )
  }
  return nodes
})

const displayedStrongest = computed(() => {
  if (showAllStrongest.value) return strongList.value
  return strongList.value.slice(0, 10)
})

const icons = {
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"/><path d="M10 21v1a1 1 0 001 1h2a1 1 0 001-1v-1"/></svg>',
  graph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 01-1.11-1.65l-.54-4.81A1 1 0 018.34 3h7.32a1 1 0 01.99 1.1l-.54 5.01A2 2 0 0115 10.76L12 14l-3-3.24z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  fade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
}

async function loadMemory() {
  try {
    const result = await api<AriaStatus>('/api/aria/status')
    console.log('[memory] API response keys:', Object.keys(result))
    console.log('[memory] graph keys:', result.graph ? Object.keys(result.graph) : 'no graph')
    console.log('[memory] pinnedNodes:', Array.isArray(result.graph?.pinnedNodes) ? result.graph.pinnedNodes.length : 'not array')
    console.log('[memory] strongestNodes:', Array.isArray(result.graph?.strongestNodes) ? result.graph.strongestNodes.length : 'not array')
    data.value = result
    error.value = ''
  } catch (e) {
    console.error('[memory] Load failed:', e)
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

useVisibilityRefresh(loadMemory)

onMounted(loadMemory)
</script>

<style scoped>
.section {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  animation: fadeSection .2s ease;
}

.wm-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  align-items: start;
}
.wm-wide { grid-column: 1 / -1; }
.wm-label {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.wm-value {
  font-size: 14px;
  color: var(--text);
}
.wm-tracking {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.04);
}
.wm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.wm-activated {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
}
.wm-updated {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-ghost);
}

.kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.search-bar svg {
  width: 16px;
  height: 16px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.search-bar input {
  flex: 1;
  background: none;
  border: none;
  color: var(--text);
  font-size: 14px;
  font-family: var(--mono);
  outline: none;
}
.search-bar input::placeholder { color: var(--text-ghost); }
.type-select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 8px;
  outline: none;
  cursor: pointer;
}
.type-select:focus { border-color: var(--accent); }

.node-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 10px;
  font-style: italic;
}

.empty-hint {
  color: var(--text-ghost);
  text-align: center;
  font-size: 13px;
}

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
  .wm-grid { grid-template-columns: 1fr; }
  .kv-grid { grid-template-columns: 1fr 1fr; }
  .search-bar { flex-wrap: wrap; }
  .type-select { width: 100%; }
}
</style>
