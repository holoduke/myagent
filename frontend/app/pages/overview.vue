<template>
  <div class="section">
    <LayoutSectionHeader>System Overview</LayoutSectionHeader>

    <div v-if="error" class="card">
      <p style="color:var(--red)">Failed to load: {{ error }}</p>
    </div>

    <template v-else-if="data">
      <!-- Master Brain Switch -->
      <div class="master-switch" :class="{ off: !brainEnabled }">
        <div class="master-switch-left">
          <button class="br-toggle" :class="{ on: brainEnabled }" :disabled="toggling" @click="toggleBrain">
            <span class="br-toggle-knob" />
          </button>
          <div>
            <span class="master-switch-label">Brain {{ brainEnabled ? 'Active' : 'Disabled' }}</span>
            <span class="master-switch-hint">{{ brainEnabled ? 'All AI processing is running' : 'All Claude API calls are paused — zero token consumption' }}</span>
          </div>
        </div>
      </div>

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
          <div v-if="failures > 0" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
            <button class="btn sm" :disabled="resetting" @click="resetFailures">
              {{ resetting ? 'Resetting...' : 'Reset Failures' }}
            </button>
          </div>
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
              <div class="wm-val">{{ wm.shortTermTracking.map(trackingItemText).join(', ') }}</div>
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
import { trackingItemText } from '~/types/aria'

const { api } = useApi()
const { timeAgo } = useTimeAgo()
const { showToast } = useToast()

const data = ref<DashboardData | null>(null)
const error = ref('')
const resetting = ref(false)
const toggling = ref(false)

const brainEnabled = computed(() => data.value?.brainEnabled ?? true)
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

async function toggleBrain() {
  toggling.value = true
  try {
    const newState = !brainEnabled.value
    await api('/api/brain-config', {
      method: 'PUT',
      body: { enabled: newState },
    })
    showToast(newState ? 'Brain enabled' : 'Brain disabled — zero token usage', 'success')
    await loadDashboard()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Toggle failed', 'error')
  } finally {
    toggling.value = false
  }
}

async function resetFailures() {
  resetting.value = true
  try {
    await api('/api/brain/reset-failures', { method: 'POST' })
    showToast('Failures reset', 'success')
    await loadDashboard()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Reset failed', 'error')
  } finally {
    resetting.value = false
  }
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

/* ── Master Brain Switch ── */
.master-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  margin-bottom: 12px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: rgba(168,85,247,0.05);
  transition: all .3s;
}
.master-switch.off {
  border-color: var(--red, #ef4444);
  background: rgba(239,68,68,0.06);
}
.master-switch-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.master-switch-label {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  display: block;
}
.master-switch-hint {
  font-size: 11px;
  color: var(--text-muted);
  display: block;
  margin-top: 2px;
}

/* ── Toggle (same as brain.vue) ── */
.br-toggle {
  width: 36px; height: 20px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg); cursor: pointer; position: relative; transition: all .2s; padding: 0; flex-shrink: 0;
}
.br-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
.br-toggle.on { background: rgba(168,85,247,0.2); border-color: var(--accent); }
.br-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--text-muted); transition: all .2s;
}
.br-toggle.on .br-toggle-knob { left: 18px; background: var(--accent); box-shadow: 0 0 8px rgba(168,85,247,0.4); }

@media (max-width: 768px) {
  .section { padding: 16px 12px; }
}
</style>
