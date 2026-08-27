<template>
  <div class="intg-card">
    <div class="intg-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="#34A853" stroke-width="2" style="width:20px;height:20px"><path d="M5 3l14 9-14 9V3z"/></svg>
      <h3>{{ status?.appLabel || 'Play Store' }}</h3>
      <span class="intg-status" :class="status?.configured ? 'online' : 'offline'">
        {{ status?.configured ? 'Configured' : 'No key' }}
      </span>
    </div>

    <div v-if="loading" class="ps-hint">Loading…</div>
    <div v-else-if="loadError" class="ps-error">{{ loadError }}</div>

    <template v-else-if="status">
      <div v-if="!status.configured" class="ps-hint">
        Add a service-account key at <code>/data/playstore/service-account.json</code> to enable vitals and reviews.
      </div>

      <template v-else>
        <div class="ps-toolbar">
          <span class="ps-meta">
            {{ snapshotAge }}
          </span>
          <button class="btn" :disabled="refreshing" @click="refresh">
            {{ refreshing ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>

        <!-- Vitals -->
        <label class="intg-label">Vitals (last {{ vitalsTail.length }} days)</label>
        <div v-if="vitalsTail.length" class="ps-table-wrap">
          <table class="ps-table">
            <thead>
              <tr><th>Date</th><th>Crash</th><th>ANR</th><th>Users</th></tr>
            </thead>
            <tbody>
              <tr v-for="d in vitalsTail" :key="d.date">
                <td>{{ d.date }}</td>
                <td>{{ pct(d.crashRate) }}</td>
                <td>{{ pct(d.anrRate) }}</td>
                <td>{{ users(d.distinctUsers) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="ps-hint">No vitals data yet — refresh to fetch.</div>

        <!-- Reviews -->
        <label class="intg-label" style="margin-top:14px">Recent reviews</label>
        <template v-if="reviews.length">
          <div v-for="r in reviews" :key="r.reviewId" class="ps-review">
            <div class="ps-review-head">
              <span class="ps-stars" :class="r.stars <= 2 ? 'low' : ''">{{ '★'.repeat(r.stars) }}{{ '☆'.repeat(5 - r.stars) }}</span>
              <span class="ps-meta">{{ r.date }} · {{ r.language }}</span>
              <span class="ps-badge" :class="r.replied ? 'ok' : 'warn'">{{ r.replied ? 'replied' : 'no reply' }}</span>
            </div>
            <div class="ps-review-text">{{ r.text || '(no text)' }}</div>
          </div>
        </template>
        <div v-else class="ps-hint">No reviews in the snapshot window.</div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { PlayStoreStatus } from '~/types/aria'

const emit = defineEmits<{ error: [msg: string] }>()

const { api } = useApi()
const { timeAgo } = useTimeAgo()

const status = ref<PlayStoreStatus | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const loadError = ref('')

const vitalsTail = computed(() => (status.value?.snapshot?.vitals ?? []).slice(-7).reverse())
const reviews = computed(() => (status.value?.snapshot?.reviews ?? []).slice(0, 10))
const snapshotAge = computed(() => {
  const t = status.value?.snapshot?.generatedAt
  return t ? `Data from ${timeAgo(t)}` : 'No data fetched yet'
})

function pct(v: number | null): string {
  return v === null ? '–' : `${(v * 100).toFixed(2)}%`
}
function users(v: number | null): string {
  if (v === null) return '–'
  return v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    status.value = await api<PlayStoreStatus>('/api/playstore/status')
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Failed to load Play Store status'
  } finally {
    loading.value = false
  }
}

async function refresh() {
  refreshing.value = true
  try {
    const res = await api<{ snapshot: PlayStoreStatus['snapshot'] }>('/api/playstore/refresh', { method: 'POST' })
    if (status.value) status.value = { ...status.value, snapshot: res.snapshot }
  } catch (e) {
    emit('error', e instanceof Error ? e.message : 'Refresh failed')
  } finally {
    refreshing.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ps-hint { color: var(--text-ghost); font-size: 13px; padding: 8px 0; }
.ps-error { color: var(--red); font-size: 13px; padding: 8px 0; }
.ps-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.ps-meta { font-family: var(--mono); font-size: 10px; color: var(--text-muted); }
.ps-table-wrap { overflow-x: auto; }
.ps-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ps-table th { text-align: left; color: var(--text-muted); font-weight: 500; padding: 4px 8px 4px 0; }
.ps-table td { font-family: var(--mono); font-size: 11px; padding: 4px 8px 4px 0; border-top: 1px solid rgba(255,255,255,0.04); }
.ps-review { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
.ps-review-head { display: flex; align-items: center; gap: 8px; }
.ps-stars { color: #FBBF24; font-size: 12px; letter-spacing: 1px; }
.ps-stars.low { color: var(--red); }
.ps-badge { margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 8px; }
.ps-badge.ok { color: var(--green, #22c55e); background: rgba(34,197,94,0.1); }
.ps-badge.warn { color: #FBBF24; background: rgba(251,191,36,0.1); }
.ps-review-text { font-size: 12px; color: var(--text); margin-top: 4px; }
</style>
