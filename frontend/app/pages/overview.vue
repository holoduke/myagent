<template>
  <div class="section">
    <LayoutSectionHeader>System Overview</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="data">
      <div class="card-grid">
        <!-- System Status -->
        <UiCard title="System Status" :icon="icons.clock">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <UiStatusDot :status="systemStatus" />
            <span style="font-family:var(--mono);font-size:13px;color:var(--text)">{{ systemLabel }}</span>
          </div>
          <UiKvRow label="Queue Depth" :value="data.queueDepth ?? 0" />
          <UiKvRow label="Consecutive Failures" :value="failures" :value-class="failures > 0 ? (failures < 5 ? 'warn' : 'bad') : 'good'" />
          <UiKvRow label="Pending Self-Mod" :value="data.brainState?.pendingSelfMod ? 'Yes' : 'No'" :value-class="data.brainState?.pendingSelfMod ? 'warn' : ''" />
        </UiCard>

        <!-- Brain Activity -->
        <UiCard title="Brain Activity" :icon="icons.brain">
          <UiKvRow label="Total Thinks" :value="bs.totalThinks || 0" />
          <UiKvRow label="Total Cost" :value="'$' + (bs.totalCost || 0).toFixed(2)" />
          <UiKvRow label="Last Think" :value="timeAgo(bs.lastThinkTick)" />
          <UiKvRow label="Last Consolidate" :value="timeAgo(bs.lastConsolidateTick)" />
          <UiKvRow label="Last Reflect" :value="timeAgo(bs.lastReflectTick)" />
          <UiKvRow label="Messages Today" :value="(bs.messagesToday || 0) + '/5'" />
          <UiKvRow label="Last Message" :value="timeAgo(bs.lastMessageTime)" />
        </UiCard>

        <!-- Integrations -->
        <UiCard title="Integrations" :icon="icons.link">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <UiStatusDot :status="data.whatsapp?.connected ? 'ok' : 'err'" />
            <span style="font-size:13px;color:var(--text)">WhatsApp</span>
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-left:auto">{{ data.whatsapp?.contactCount || 0 }} contacts</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <UiStatusDot :status="(data.gmail?.authenticated || 0) > 0 ? 'ok' : 'warn'" />
            <span style="font-size:13px;color:var(--text)">Gmail</span>
            <span style="font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-left:auto">{{ data.gmail?.authenticated || 0 }}/{{ data.gmail?.total || 0 }} active</span>
          </div>
        </UiCard>

        <!-- Working Memory -->
        <UiCard title="Working Memory" :icon="icons.monitor">
          <template v-if="wm.currentContext || wm.mood || (wm.shortTermTracking && wm.shortTermTracking.length)">
            <div v-if="wm.mood" class="wm-field">
              <div class="wm-label">Mood</div>
              <div class="wm-val">{{ wm.mood }}</div>
            </div>
            <div v-if="wm.currentContext" class="wm-field">
              <div class="wm-label">Context</div>
              <div class="wm-val">{{ wm.currentContext }}</div>
            </div>
            <div v-if="wm.shortTermTracking && wm.shortTermTracking.length" class="wm-field">
              <div class="wm-label">Tracking</div>
              <div class="wm-val">{{ wm.shortTermTracking.join(', ') }}</div>
            </div>
            <UiKvRow label="Last Updated" :value="timeAgo(wm.lastUpdated)" />
          </template>
          <div v-else style="color:var(--text-ghost);font-size:13px;padding:10px 0">
            Awaiting first think tick
          </div>
        </UiCard>
      </div>

      <!-- Quick Stats -->
      <div class="stat-grid" style="margin-top:8px">
        <UiStatCard :value="data.graph?.nodeCount || 0" label="Nodes" />
        <UiStatCard :value="data.graph?.edgeCount || 0" label="Edges" />
        <UiStatCard :value="bs.totalThinks || 0" label="Thinks" />
        <UiStatCard :value="'$' + (bs.totalCost || 0).toFixed(2)" label="Cost" />
        <UiStatCard :value="data.whitelistCount || 0" label="Whitelist" />
        <UiStatCard :value="data.scheduledCount || 0" label="Scheduled" />
      </div>
    </template>

    <div v-else style="text-align:center;padding:40px;color:var(--text-ghost)">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import type { DashboardData } from '~/types/aria'

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const data = ref<DashboardData | null>(null)
const error = ref('')

const bs = computed(() => data.value?.brainState ?? {} as Partial<DashboardData['brainState']>)
const wm = computed(() => data.value?.workingMemory ?? {} as Partial<DashboardData['workingMemory']>)
const failures = computed(() => (data.value?.brainState?.consecutiveFailures || 0))
const systemStatus = computed<'ok' | 'warn' | 'err'>(() => {
  if (failures.value >= 5) return 'err'
  if (failures.value > 0) return 'warn'
  return 'ok'
})
const systemLabel = computed(() => {
  if (failures.value >= 5) return 'Unhealthy'
  if (failures.value > 0) return 'Degraded'
  return 'Operational'
})

const icons = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 3-2 5.5-4 7.5S12 22 12 22s-1-3.5-3-5.5S5 12 5 9a7 7 0 017-7z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>',
}

async function loadDashboard() {
  try {
    data.value = await api<DashboardData>('/api/dashboard')
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  }
}

useVisibilityRefresh(loadDashboard)

let refreshInterval: ReturnType<typeof setInterval>

onMounted(() => {
  loadDashboard()
  refreshInterval = setInterval(loadDashboard, 30000)
})

onUnmounted(() => {
  clearInterval(refreshInterval)
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
